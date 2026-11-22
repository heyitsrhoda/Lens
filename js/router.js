// js/router.js — hash routing (relative paths, works on Vercel, locally and under any sub-path).
import { useState, useEffect } from './lib.js';
import { useStore } from './store.js';

export const ROUTES = ['/', '/start', '/stack', '/discover', '/outreach', '/studio', '/schedule', '/analytics', '/chat', '/settings'];

// Old v1 routes → where they live now (with the matching Settings tab).
export const REDIRECTS = {
  '/setup': { path: '/settings', params: { tab: 'product' } },
  '/connections': { path: '/settings', params: { tab: 'connections' } },
};

// Reachable before onboarding is finished.
export const OPEN_ROUTES = ['/start', '/settings'];

const listeners = new Set();

function notify() {
  for (const fn of Array.from(listeners)) fn();
}

export function parseHash(hash = typeof location !== 'undefined' ? location.hash : '') {
  const raw = String(hash || '').replace(/^#!?/, '');
  const qi = raw.indexOf('?');
  let path = (qi >= 0 ? raw.slice(0, qi) : raw).trim();
  const query = qi >= 0 ? raw.slice(qi + 1) : '';
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  const params = {};
  if (query) {
    for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  }
  return { path, params };
}

export function href(path) {
  return '#' + (path.startsWith('/') ? path : '/' + path);
}

// Build '/settings?tab=data' from a path and a params object.
export function toPath(path, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

// navigate('/studio?thread=t1'); navigate('/start', { replace: true })
export function navigate(path, { replace = false } = {}) {
  const target = href(path);
  if (location.hash === target) return;
  if (replace) {
    try {
      history.replaceState(history.state, '', location.pathname + location.search + target);
    } catch {
      location.replace(target);
      return;
    }
    notify();
  } else {
    location.hash = target; // fires hashchange
  }
}

export function resolveRoute(route, onboarded) {
  let { path, params } = route;
  if (REDIRECTS[path]) {
    const r = REDIRECTS[path];
    path = r.path;
    params = { ...r.params, ...params };
  }
  if (!ROUTES.includes(path)) {
    path = '/';
    params = {};
  }
  if (!onboarded && !OPEN_ROUTES.includes(path)) {
    path = '/start';
    params = {};
  } else if (onboarded && path === '/start') {
    path = '/';
    params = {};
  }
  if (path === route.path && params === route.params) return route;
  return { path, params };
}

export function useRoute() {
  const onboarded = useStore((s) => !!s.onboarded);
  const [route, setRoute] = useState(() => parseHash());

  useEffect(() => {
    const update = () => {
      setRoute((prev) => {
        const next = parseHash();
        const same = prev.path === next.path && JSON.stringify(prev.params) === JSON.stringify(next.params);
        return same ? prev : next;
      });
    };
    listeners.add(update);
    window.addEventListener('hashchange', update);
    window.addEventListener('popstate', update);
    update();
    return () => {
      listeners.delete(update);
      window.removeEventListener('hashchange', update);
      window.removeEventListener('popstate', update);
    };
  }, []);

  const resolved = resolveRoute(route, onboarded);
  const target = resolved === route ? null : toPath(resolved.path, resolved.params);

  // Keep the address bar honest when we redirect (old route, unknown path or onboarding gate).
  useEffect(() => {
    if (target) navigate(target, { replace: true });
  }, [target]);

  return resolved;
}
