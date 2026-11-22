#!/usr/bin/env python3
"""Lens local dev server — no Node needed (Python 3.9+, standard library only).

    python3 dev/serve.py            # http://127.0.0.1:8000
    PORT=8080 python3 dev/serve.py
    YOU_API_KEY=... python3 dev/serve.py   # optional "owner-funded" key, same as the Vercel env var

Serves the repo root as static files (correct MIME types for ES modules) and emulates the
Vercel function api/you.js so live mode works locally:

    GET  /api/you?op=status   -> {"ok": true, "envKey": bool}
    POST /api/you?op=search   -> https://ydc-index.io/v1/search            (X-API-Key)
    POST /api/you?op=extract  -> https://ydc-index.io/v1/extract           (X-API-Key)
    POST /api/you?op=agent    -> https://api.you.com/v1/chat/completions   (Bearer; Inference Router, default)
                                 https://api.you.com/v1/answer             (agent "answer")
                                 https://api.you.com/v1/agents/runs        (agent "express" | "advanced" | custom id)

The key comes from the browser's `x-you-key` header, else the YOU_API_KEY environment variable.
Keys and request bodies are never logged. Dotfiles (.git, credentials, ...) are never served.

LinkedIn (api/linkedin/*.js) is not emulated: /api/linkedin/* answers 501 JSON here, and the app reports that
LinkedIn sign-in needs the Vercel deployment.
"""

import hashlib
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))

SEARCH_URL = "https://ydc-index.io/v1/search"
EXTRACT_URL = "https://ydc-index.io/v1/extract"
ROUTER_URL = "https://api.you.com/v1/chat/completions"
MODELS_URL = "https://api.you.com/v1/models"
ANSWER_URL = "https://api.you.com/v1/answer"
AGENTS_URL = "https://api.you.com/v1/agents/runs"

MAX_BODY = 64 * 1024
TIMEOUT_S = 55
MODEL_CACHE_S = 600
OPS = {"status", "search", "extract", "agent"}

SEARCH_FIELDS = ["query", "count", "freshness", "country", "language", "include_domains", "exclude_domains",
                 "boost_domains", "offset", "safesearch", "extraction", "crawl_timeout", "knowledge", "strict_operators"]
EXTRACT_FIELDS = ["url", "full_page", "extraction_source", "timeout", "parse_effort"]
ANSWER_FIELDS = ["freshness", "country", "language", "safesearch", "include_domains", "exclude_domains", "boost_domains"]
MODEL_PREFERENCE = [r"claude.*sonnet", r"claude", r"^gpt-5", r"^gpt", r"gemini.*pro", r"gemini", r"kimi", r"deepseek",
                    r"qwen", r"glm", r"llama", r"mistral"]

USER_AGENT = "Lens-dev-relay/1.0"
_model_cache = {}
_model_lock = threading.Lock()


class RelayError(Exception):
    def __init__(self, status, message, detail=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.detail = detail


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


def call_you(url, key, body=None, method="POST", auth="x-api-key"):
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if auth == "bearer":
        headers["Authorization"] = "Bearer " + key
    else:
        headers["X-API-Key"] = key
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


def list_models(key):
    h = hashlib.sha256(key.encode("utf-8")).hexdigest()
    with _model_lock:
        hit = _model_cache.get(h)
        if hit and time.time() - hit[0] < MODEL_CACHE_S:
            return hit[1]
    out = call_you(MODELS_URL, key, method="GET", auth="bearer")
    models = []
    for m in (out.get("data") or []) if isinstance(out, dict) else []:
        if not isinstance(m, dict) or not isinstance(m.get("id"), str):
            continue
        caps = m.get("capabilities")
        outputs = caps.get("output") if isinstance(caps, dict) else None
        if isinstance(outputs, list) and "text" not in outputs:
            continue
        mt = m.get("max_tokens")
        models.append({"id": m["id"], "maxTokens": mt if isinstance(mt, int) else None})
    with _model_lock:
        _model_cache[h] = (time.time(), models)
    return models


def rank_models(models):
    def rank(mid):
        for i, pat in enumerate(MODEL_PREFERENCE):
            if re.search(pat, mid, re.I):
                return i
        return len(MODEL_PREFERENCE)
    return sorted(models, key=lambda m: rank(m["id"]))


def to_messages(body):
    out = []
    system = body.get("system")
    if isinstance(system, str) and system.strip():
        out.append({"role": "system", "content": system.strip()})
    for m in body.get("messages") or []:
        if not isinstance(m, dict):
            continue
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        out.append({"role": "assistant" if m.get("role") == "assistant" else "user", "content": content})
    if not any(m["role"] != "system" for m in out):
        inp = body.get("input")
        inp = inp.strip() if isinstance(inp, str) else ""
        if not inp:
            raise RelayError(400, 'The agent needs "input" or "messages".')
        out.append({"role": "user", "content": inp})
    return out


def run_router(key, body):
    messages = to_messages(body)
    requested = body.get("model") if isinstance(body.get("model"), str) else ""
    requested = (requested or os.environ.get("YOU_MODEL", "")).strip()
    if requested:
        candidates = [{"id": requested, "maxTokens": None}]
    else:
        models = rank_models(list_models(key))
        if not models:
            raise RelayError(403, "This You.com key has no Inference Router models available. Check your plan at you.com/platform.")
        candidates = models[:2]
    try:
        wanted = int(body.get("maxTokens") or 1500)
    except (TypeError, ValueError):
        wanted = 1500
    # Reasoning tokens count toward max_tokens: floor at 4096, ask for low effort, and retry once with a
    # doubled limit if the reply is still empty for lack of room (mirrors api/you.js).
    wanted = max(4096, min(16000, wanted))
    effort = body.get("reasoningEffort") if body.get("reasoningEffort") in REASONING_EFFORTS else "low"
    last = None
    for m in candidates:
        try:
            return router_call(key, body, messages, m, wanted, effort)
        except RelayError as e:
            last = e
            if requested or e.status not in (400, 403, 404):
                raise
    raise last


REASONING_EFFORTS = ("minimal", "low", "medium", "high")


def router_call(key, body, messages, m, wanted, effort):
    cap = m["maxTokens"] or 32000
    max_tokens = min(wanted, cap)
    send_effort = True
    grew = False
    while True:
        payload = {"model": m["id"], "messages": messages, "stream": False, "max_tokens": max_tokens}
        if send_effort:
            payload["reasoning_effort"] = effort
        if isinstance(body.get("temperature"), (int, float)) and not isinstance(body.get("temperature"), bool):
            payload["temperature"] = body["temperature"]
        if body.get("webSearch"):
            payload["tools"] = [{"type": "web_search", "max_search_rounds": 2}]
        try:
            out = call_you(ROUTER_URL, key, payload, auth="bearer")
        except RelayError as e:
            if send_effort and e.status in (400, 422):
                send_effort = False  # a model that rejects reasoning_effort: retry once without it
                continue
            raise
        choices = out.get("choices") if isinstance(out, dict) else None
        choice = choices[0] if isinstance(choices, list) and choices else {}
        msg = choice.get("message") or {}
        text = msg.get("content") if isinstance(msg.get("content"), str) else ""
        text = text.strip()
        if not text:
            if msg.get("refusal"):
                raise RelayError(422, "The model declined: %s" % msg["refusal"])
            if choice.get("finish_reason") == "length":
                if not grew and max_tokens < cap:
                    grew = True
                    max_tokens = min(max_tokens * 2, cap)
                    continue
                raise RelayError(422, "The model ran out of room before answering. Try a shorter request.")
            raise RelayError(502, "The model returned an empty answer.")
        return {
            "provider": "router",
            "agent": "router",
            "model": out.get("model") or m["id"],
            "text": text,
            "finishReason": choice.get("finish_reason"),
            "webResults": out.get("web_results"),
            "usage": out.get("usage"),
        }


def run_answer(key, body):
    query = str(body.get("input") or "").strip()
    if not query:
        raise RelayError(400, 'The Answer API needs "input".')
    if len(query) > 400:
        raise RelayError(400, "The Answer API accepts at most 400 characters of input.")
    payload = {"query": query}
    payload.update(pick(body, ANSWER_FIELDS))
    out = call_you(ANSWER_URL, key, payload)
    return {
        "provider": "answer",
        "agent": "answer",
        "text": str(out.get("answer") or "").strip(),
        "citations": out.get("citations") if isinstance(out.get("citations"), list) else [],
        "webResults": out.get("results"),
    }


def run_legacy_agent(key, body, agent):
    inp = str(body.get("input") or "").strip()
    if not inp:
        inp = "\n\n".join("%s:\n%s" % (m["role"].upper(), m["content"]) for m in to_messages(body))
    try:
        out = call_you(AGENTS_URL, key, {"agent": agent, "input": inp, "stream": False}, auth="bearer")
    except RelayError as e:
        if e.status in (404, 410):
            return run_router(key, body)
        raise
    items = out.get("output") if isinstance(out.get("output"), list) else []
    parts = []
    for o in items:
        if isinstance(o, dict):
            if isinstance(o.get("text"), str):
                parts.append(o["text"])
            elif isinstance(o.get("content"), str):
                parts.append(o["content"])
    text = "\n\n".join(p for p in parts if p).strip()
    if not text:
        raise RelayError(502, "The You.com agent returned an empty answer.")
    return {"provider": "agents", "agent": agent, "text": text, "output": items}


def op_agent(key, body):
    agent = body.get("agent")
    agent = agent.strip() if isinstance(agent, str) else ""
    if agent in ("", "router", "chat"):
        return run_router(key, body)
    if agent == "answer":
        return run_answer(key, body)
    if not re.match(r"^[A-Za-z0-9_-]{1,64}$", agent):
        raise RelayError(400, "Unknown agent id.")
    return run_legacy_agent(key, body, agent)


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

    def do_OPTIONS(self):
        path, _ = self._route()
        if self._is_api(path):
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
                                  "error": "LinkedIn needs the Vercel deployment (dev/serve.py only serves /api/you)."})
            return True
        return False

    def do_GET(self):
        path, query = self._route()
        if self._is_api(path):
            self._api("GET", query)
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
        if self._linkedin(path):
            return
        self.send_error(405)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            raise RelayError(413, "Request body is too large (64 KB max).")
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw.strip():
            return {}
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            raise RelayError(400, "Request body must be a JSON object.")
        if not isinstance(body, dict):
            raise RelayError(400, "Request body must be a JSON object.")
        return body

    def _api(self, method, query):
        op = (query.get("op") or [""])[0]
        if op not in OPS:
            self._fail(400, "Unknown op. Use status, search, extract or agent.")
            return
        if op == "status":
            self._send_json(200, {"ok": True, "envKey": bool(os.environ.get("YOU_API_KEY"))})
            return
        if method != "POST":
            self._fail(405, "Use POST for op=%s." % op)
            return
        key = (self.headers.get("x-you-key") or "").strip() or (os.environ.get("YOU_API_KEY") or "").strip()
        try:
            body = self._read_body()
            if not key:
                raise RelayError(400, "No You.com API key. Add yours in Settings \u2192 Connections, or set YOU_API_KEY before starting dev/serve.py.")
            if op == "search":
                data = op_search(key, body)
            elif op == "extract":
                data = op_extract(key, body)
            else:
                data = op_agent(key, body)
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
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
