#!/usr/bin/env python3
"""Lens local dev server — no Node needed (Python 3.9+, standard library only).

    python3 dev/serve.py            # http://127.0.0.1:8000
    PORT=8080 python3 dev/serve.py
    YOU_API_KEY=... OPENROUTER_API_KEY=... python3 dev/serve.py   # same env vars as the Vercel deployment
    OPENROUTER_MODEL=anthropic/claude-haiku-5.5 ...                # optional; default google/gemma-4-31b-it:free

Serves the repo root as static files (correct MIME types for ES modules) and emulates the
Vercel functions api/you.js and api/ai.js so live mode works locally:

    GET  /api/you?op=status   -> {"ok": true, "envKey": bool}
    POST /api/you?op=search   -> https://ydc-index.io/v1/search            (X-API-Key)
    POST /api/you?op=extract  -> https://ydc-index.io/v1/extract           (X-API-Key)
    POST /api/you?op=agent    -> TEMPORARY shim for tabs still running the pre-OpenRouter client: same as POST /api/ai
                                 (body {system?, messages | input, maxTokens?, temperature?}), never You.com inference

    GET  /api/ai?op=status    -> {"ok": true, "key": bool, "model": str}
    POST /api/ai              -> https://openrouter.ai/api/v1/chat/completions   (Bearer OPENROUTER_API_KEY)
                                 body {system?, messages, maxTokens?, temperature?}
                                 -> {"ok": true, "data": {"text", "model", "finishReason"}}
                                  | {"ok": false, "status", "error", "code": "no-key"|"credits"|"rate"|"invalid"|"forbidden"|"upstream"}
                                 Browser POSTs whose Origin / Sec-Fetch-Site show another site get 403 "forbidden".

The You.com key comes from the browser's `x-you-key` header, else the YOU_API_KEY environment variable.
The OpenRouter key comes only from OPENROUTER_API_KEY.
Keys and request bodies are never logged. Dotfiles (.git, credentials, ...) are never served.

LinkedIn (api/linkedin/*.js) is not emulated: /api/linkedin/* answers 501 JSON here, and the app reports that
LinkedIn sign-in needs the Vercel deployment.
"""

import json
import os
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))

SEARCH_URL = "https://ydc-index.io/v1/search"
EXTRACT_URL = "https://ydc-index.io/v1/extract"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemma-4-31b-it:free"
FREE_FALLBACK = "openrouter/free"

MAX_BODY = 64 * 1024
AI_MAX_BODY = 200 * 1024
TIMEOUT_S = 55
OPS = {"status", "search", "extract", "agent"}
AI_MAX_MESSAGES = 200
AI_PASS_STATUSES = {400, 401, 402, 403, 408, 413, 422, 429, 502, 503, 504}

SEARCH_FIELDS = ["query", "count", "freshness", "country", "language", "include_domains", "exclude_domains",
                 "boost_domains", "offset", "safesearch", "extraction", "crawl_timeout", "knowledge", "strict_operators"]
EXTRACT_FIELDS = ["url", "full_page", "extraction_source", "timeout", "parse_effort"]
USER_AGENT = "Lens-dev-relay/1.0"


class RelayError(Exception):
    def __init__(self, status, message, detail=None, code=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.detail = detail
        self.code = code


def pick(obj, fields):
    return {f: obj[f] for f in fields if f in obj and obj[f] is not None and obj[f] != ""}


def upstream_message(status, body, text):
    detail = ""
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            detail = err.get("message") or err.get("code") or ""
        elif isinstance(err, str):
            detail = body.get("message") or err
        if not detail and isinstance(body.get("message"), str):
            detail = body["message"]
        if not detail and isinstance(body.get("detail"), str):
            detail = body["detail"]
        if not detail and isinstance(body.get("detail"), list) and body["detail"]:
            first = body["detail"][0]
            detail = first.get("msg", "") if isinstance(first, dict) else ""
        if not detail and isinstance(body.get("errors"), list) and body["errors"]:
            first = body["errors"][0]
            detail = (first.get("detail") or first.get("title") or "") if isinstance(first, dict) else ""
    elif text:
        detail = text[:200]
    prefix = {
        400: "You.com could not process the request",
        401: "You.com rejected the API key",
        402: "The You.com account is out of credits",
        403: "This You.com key is not allowed to use this API",
        404: "You.com endpoint not found",
        422: "You.com did not accept the request parameters",
        429: "You.com rate limit reached \u2014 try again in a minute",
        503: "You.com is temporarily unavailable",
        504: "You.com timed out",
    }.get(status, "You.com request failed (HTTP %d)" % status)
    if detail and detail not in prefix:
        return "%s: %s" % (prefix, detail)
    return prefix + "."


def call_you(url, key, body=None, method="POST"):
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT, "X-API-Key": key}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace") if e.fp else ""
        status = e.code
    except (socket.timeout, TimeoutError):
        raise RelayError(504, "You.com took too long to respond (55 s). Try again.")
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), (socket.timeout, TimeoutError)):
            raise RelayError(504, "You.com took too long to respond (55 s). Try again.")
        raise RelayError(502, "Could not reach You.com from the dev relay. Check your network.")
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = None
    if status < 200 or status >= 300:
        raise RelayError(status, upstream_message(status, parsed, "" if parsed is not None else raw), parsed)
    if parsed is None:
        raise RelayError(502, "You.com returned a response the relay could not read.")
    return parsed


# ------------------------------------------------------------------ ops

def op_search(key, body):
    q = body.get("query")
    q = q.strip() if isinstance(q, str) else ""
    if not q:
        raise RelayError(400, 'Search needs a non-empty "query".')
    payload = pick(body, SEARCH_FIELDS)
    payload["query"] = q
    return call_you(SEARCH_URL, key, payload)


def op_extract(key, body):
    url = body.get("url")
    url = url.strip() if isinstance(url, str) else ""
    if not re.match(r"^https?://", url, re.I):
        raise RelayError(400, 'Extract needs an absolute http(s) "url".')
    payload = {"full_page": {"extraction_formats": ["markdown"]}}
    payload.update(pick(body, EXTRACT_FIELDS))
    payload["url"] = url
    return call_you(EXTRACT_URL, key, payload)


# ------------------------------------------------------------------ AI (mirrors api/ai.js)

def ai_model():
    return (os.environ.get("OPENROUTER_MODEL") or "").strip() or DEFAULT_MODEL


def ai_key():
    return (os.environ.get("OPENROUTER_API_KEY") or "").strip()


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def ai_payload(body):
    system = body.get("system")
    if system is not None and not isinstance(system, str):
        raise RelayError(400, '"system" must be a string.', code="invalid")
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs:
        raise RelayError(400, '"messages" must be a non-empty array of { role, content }.', code="invalid")
    if len(msgs) > AI_MAX_MESSAGES:
        raise RelayError(400, "At most %d messages." % AI_MAX_MESSAGES, code="invalid")
    messages = []
    if isinstance(system, str) and system.strip():
        messages.append({"role": "system", "content": system.strip()})
    for m in msgs:
        if not isinstance(m, dict):
            raise RelayError(400, "Each message must be an object { role, content }.", code="invalid")
        if m.get("role") not in ("user", "assistant"):
            raise RelayError(400, 'Message roles must be "user" or "assistant" (send the system prompt as "system").', code="invalid")
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            raise RelayError(400, 'Each message needs non-empty string "content".', code="invalid")
        messages.append({"role": m["role"], "content": content})
    if not any(m["role"] == "user" for m in messages):
        raise RelayError(400, '"messages" needs at least one user message.', code="invalid")
    max_tokens = 1500
    mt = body.get("maxTokens")
    if mt is not None:
        try:
            mt = float(mt)
        except (TypeError, ValueError):
            raise RelayError(400, '"maxTokens" must be a number.', code="invalid")
        if not _num(mt):
            raise RelayError(400, '"maxTokens" must be a number.', code="invalid")
        max_tokens = int(min(8000, max(64, round(mt))))
    primary = ai_model()
    payload = {"model": primary, "messages": messages, "max_tokens": max_tokens, "stream": False}
    if primary.endswith(":free") or primary == FREE_FALLBACK:
        payload["models"] = [primary, FREE_FALLBACK]
        # Free models often reason; keep thinking short and leave room for the answer.
        payload["reasoning"] = {"effort": "low", "exclude": True}
        payload["max_tokens"] = max(payload["max_tokens"], 4000)
    t = body.get("temperature")
    if t is not None:
        if not _num(t):
            raise RelayError(400, '"temperature" must be a number.', code="invalid")
        payload["temperature"] = min(1.5, max(0.0, float(t)))
    return payload


def ai_error_detail(body, text):
    if isinstance(body, dict):
        e = body.get("error")
        if isinstance(e, dict) and isinstance(e.get("message"), str):
            return e["message"][:300]
        if isinstance(e, str):
            return e[:300]
        if isinstance(body.get("message"), str):
            return body["message"][:300]
    # Raw (non-JSON) bodies are only used when they are plain text: an HTML error page never reaches the user.
    if not text or re.match(r"^\s*<", text) or re.search(r"<(html|head|body|title)[\s>]", text, re.I):
        return ""
    return " ".join(text.split())[:200]


def ai_upstream_error(status, detail):
    if status == 402:
        return RelayError(402, "OpenRouter is out of credits.", code="credits")
    if status == 429:
        return RelayError(429, "OpenRouter rate limit reached. Try again in a minute.", code="rate")
    prefix = {
        400: "OpenRouter could not process the request",
        401: "OpenRouter rejected the API key",
        403: "OpenRouter refused the request",
        408: "OpenRouter timed out",
        502: "The AI model is unavailable right now",
        503: "No AI provider is available right now",
    }.get(status, "OpenRouter request failed (HTTP %d)" % status)
    message = "%s: %s" % (prefix, detail) if detail and detail not in prefix else prefix + "."
    return RelayError(status if status in AI_PASS_STATUSES else 502, message, code="upstream")


def _error_status(err):
    code = err.get("code") if isinstance(err, dict) else None
    return code if isinstance(code, int) and not isinstance(code, bool) and 400 <= code < 600 else 502


def ai_chat(key, payload, origin):
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
        "X-Title": "Lens",
        "User-Agent": USER_AGENT,
    }
    if origin:
        headers["HTTP-Referer"] = origin
    req = urllib.request.Request(OPENROUTER_URL, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace") if e.fp else ""
        status = e.code
    except (socket.timeout, TimeoutError):
        raise RelayError(504, "The AI took too long to respond (55 s). Try again.", code="upstream")
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), (socket.timeout, TimeoutError)):
            raise RelayError(504, "The AI took too long to respond (55 s). Try again.", code="upstream")
        raise RelayError(502, "Could not reach OpenRouter from the dev server. Check your network.", code="upstream")
    try:
        out = json.loads(raw) if raw else None
    except ValueError:
        out = None
    if status < 200 or status >= 300:
        raise ai_upstream_error(status, ai_error_detail(out, "" if out is not None else raw))
    if not isinstance(out, dict):
        raise RelayError(502, "OpenRouter returned a response the server could not read.", code="upstream")
    # Errors after generation started can arrive with HTTP 200.
    if out.get("error") and not isinstance(out.get("choices"), list):
        raise ai_upstream_error(_error_status(out.get("error")), ai_error_detail(out, ""))
    choices = out.get("choices") if isinstance(out.get("choices"), list) else []
    choice = choices[0] if choices and isinstance(choices[0], dict) else None
    if choice is None:
        raise RelayError(502, "OpenRouter returned no answer.", code="upstream")
    finish = choice.get("finish_reason") or choice.get("native_finish_reason")
    if finish == "error" or choice.get("error"):
        err = choice.get("error") if isinstance(choice.get("error"), dict) else {}
        msg = err.get("message") if isinstance(err.get("message"), str) else ""
        raise ai_upstream_error(_error_status(err), msg[:300])
    msg = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    content = msg.get("content")
    if isinstance(content, list):
        content = "".join(p.get("text", "") if isinstance(p, dict) and isinstance(p.get("text"), str) else (p if isinstance(p, str) else "") for p in content)
    text = content.strip() if isinstance(content, str) else ""
    if not text:
        refusal = msg.get("refusal")
        if isinstance(refusal, str) and refusal.strip():
            raise RelayError(422, "The model declined: %s" % refusal.strip()[:300], code="upstream")
        if finish == "length":
            raise RelayError(422, "The model ran out of room before answering. Try a shorter request.", code="upstream")
        raise RelayError(502, "The model returned an empty answer.", code="upstream")
    model = out.get("model") if isinstance(out.get("model"), str) and out.get("model") else payload["model"]
    return {"text": text, "model": model, "finishReason": finish}


# ------------------------------------------------------------------ server

class LensHandler(SimpleHTTPRequestHandler):
    server_version = "LensDev/1.0"
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
        ".wasm": "application/wasm",
        ".md": "text/markdown; charset=utf-8",
    })

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # Paths only — never headers or bodies (no keys in logs).
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _route(self):
        parsed = urllib.parse.urlsplit(self.path)
        return parsed.path, urllib.parse.parse_qs(parsed.query)

    def _send_json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _fail(self, status, error, detail=None):
        body = {"ok": False, "status": status, "error": error}
        if detail is not None:
            body["detail"] = detail
        self._send_json(status, body)

    def _blocked(self, path):
        parts = [p for p in urllib.parse.unquote(path).split("/") if p]
        return any(p.startswith(".") for p in parts)

    def _is_api(self, path):
        return path == "/api/you" or path.startswith("/api/you/") or path == "/api/you.js"

    def _is_ai(self, path):
        return path in ("/api/ai", "/api/ai/", "/api/ai.js")

    def do_OPTIONS(self):
        path, _ = self._route()
        if self._is_api(path) or self._is_ai(path):
            self.send_response(204)
            self.send_header("Allow", "GET, POST, OPTIONS")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_error(405)

    def do_HEAD(self):
        path, _ = self._route()
        if self._blocked(path) or path.startswith("/api/"):
            self.send_error(404)
            return
        super().do_HEAD()

    def _linkedin(self, path):
        # LinkedIn sign-in/posting are Vercel functions (api/linkedin/*.js) that need the deployment's
        # LINKEDIN_CLIENT_ID/SECRET and an HTTPS callback; this dev server does not emulate them.
        if path == "/api/linkedin" or path.startswith("/api/linkedin/"):
            self._send_json(501, {"ok": False, "connected": False,
                                  "error": "LinkedIn needs the Vercel deployment (dev/serve.py only serves /api/you and /api/ai)."})
            return True
        return False

    def do_GET(self):
        path, query = self._route()
        if self._is_api(path):
            self._api("GET", query)
            return
        if self._is_ai(path):
            self._ai("GET", query)
            return
        if self._linkedin(path):
            return
        if self._blocked(path) or path.startswith("/api/"):
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        path, query = self._route()
        if self._is_api(path):
            self._api("POST", query)
            return
        if self._is_ai(path):
            self._ai("POST", query)
            return
        if self._linkedin(path):
            return
        self.send_error(405)

    def _read_body(self, limit=MAX_BODY, code=None, allow_empty=True):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > limit:
            raise RelayError(413, "Request body is too large (%d KB max)." % (limit // 1024), code=code)
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw.strip():
            if allow_empty:
                return {}
            raise RelayError(400, "Request body must be a JSON object.", code=code)
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            raise RelayError(400, "Request body must be a JSON object.", code=code)
        if not isinstance(body, dict):
            raise RelayError(400, "Request body must be a JSON object.", code=code)
        return body

    def _origin(self):
        host = (self.headers.get("Host") or "").strip()
        return "http://" + host if re.match(r"^[A-Za-z0-9.-]+(:\d{1,5})?$", host) else ""

    def _assert_same_origin(self):
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        forbidden = RelayError(403, "Lens AI only answers requests from the Lens app itself.", code="forbidden")
        if site and site not in ("same-origin", "none"):
            raise forbidden
        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            return
        try:
            origin_host = (urllib.parse.urlsplit(origin).netloc or "").lower()
        except ValueError:
            origin_host = ""
        host = (self.headers.get("Host") or "").strip().lower()
        if not origin_host or not host or origin_host != host:
            raise forbidden

    def _ai_post(self, body_to_request):
        try:
            self._assert_same_origin()
            body = self._read_body(AI_MAX_BODY, code="invalid", allow_empty=False)
            payload = ai_payload(body_to_request(body))
            key = ai_key()
            if not key:
                raise RelayError(500, "AI isn't configured on this deployment (OPENROUTER_API_KEY).", code="no-key")
            data = ai_chat(key, payload, self._origin())
            self._send_json(200, {"ok": True, "data": data})
        except RelayError as e:
            if e.code != "invalid":
                sys.stderr.write("[ai-relay] failed with status %d (%s)\n" % (e.status, e.code or "upstream"))
            self._send_json(e.status, {"ok": False, "status": e.status, "error": e.message, "code": e.code or "upstream"})
        except Exception as e:  # noqa: BLE001 — never leak internals (or keys) to the client
            sys.stderr.write("[ai-relay] crashed: %s\n" % type(e).__name__)
            self._send_json(500, {"ok": False, "status": 500, "error": "The AI relay hit an unexpected error.", "code": "upstream"})

    def _ai(self, method, query):
        if method == "GET":
            if (query.get("op") or [""])[0] != "status":
                self._send_json(400, {"ok": False, "status": 400, "error": "Use GET /api/ai?op=status, or POST a chat request.", "code": "invalid"})
                return
            self._send_json(200, {"ok": True, "key": bool(ai_key()), "model": ai_model()})
            return
        self._ai_post(lambda body: body)

    @staticmethod
    def _agent_body(body):
        # Temporary op=agent shim: old clients send {system, messages | input, maxTokens, temperature}.
        msgs = body.get("messages")
        if not (isinstance(msgs, list) and msgs):
            inp = body.get("input")
            if isinstance(inp, str) and inp.strip():
                msgs = [{"role": "user", "content": inp}]
        return {"system": body.get("system"), "messages": msgs,
                "maxTokens": body.get("maxTokens"), "temperature": body.get("temperature")}

    def _api(self, method, query):
        op = (query.get("op") or [""])[0]
        if op not in OPS:
            self._fail(400, "Unknown op. Use status, search or extract (AI calls use /api/ai; reload Lens if it is out of date).")
            return
        if op == "status":
            self._send_json(200, {"ok": True, "envKey": bool(os.environ.get("YOU_API_KEY"))})
            return
        if method != "POST":
            self._fail(405, "Use POST for op=%s." % op)
            return
        if op == "agent":
            self._ai_post(self._agent_body)
            return
        key = (self.headers.get("x-you-key") or "").strip() or (os.environ.get("YOU_API_KEY") or "").strip()
        try:
            body = self._read_body()
            if not key:
                raise RelayError(400, "No You.com API key. Add yours in Settings \u2192 Connections, or set YOU_API_KEY before starting dev/serve.py.")
            if op == "search":
                data = op_search(key, body)
            else:
                data = op_extract(key, body)
            self._send_json(200, {"ok": True, "data": data})
        except RelayError as e:
            sys.stderr.write("[you-relay] op=%s failed with status %d\n" % (op, e.status))
            self._fail(e.status, e.message, e.detail)
        except Exception as e:  # noqa: BLE001 — never leak internals (or keys) to the client
            sys.stderr.write("[you-relay] op=%s crashed: %s\n" % (op, type(e).__name__))
            self._fail(500, "The You.com relay hit an unexpected error.")


def main():
    try:
        port = int(os.environ.get("PORT") or 8000)
    except ValueError:
        port = 8000
    host = os.environ.get("HOST") or "127.0.0.1"
    httpd = ThreadingHTTPServer((host, port), LensHandler)
    httpd.daemon_threads = True
    shown = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    print("Lens dev server: http://%s:%d  (serving %s)" % (shown, port, ROOT))
    print("You.com relay at /api/you \u2014 env key %s" % ("set" if os.environ.get("YOU_API_KEY") else "not set (users bring their own key)"))
    print("AI relay at /api/ai \u2014 OPENROUTER_API_KEY %s, model %s" % ("set" if ai_key() else "not set", ai_model()))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
