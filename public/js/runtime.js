/* ---------------------------------------------------------------------------
   Runtime detection and backend discovery.

   The app is plain static files, so it can be served from anywhere. What
   differs is *where the live server is*:

     • served by the Node server itself  → the backend is the same origin
     • served from a static host         → the backend is found through a small
                                           hint file, and the app talks to it
                                           cross-origin
     • no backend reachable at all       → the app shows an honest "can't reach
                                           the server" screen. Never fake data.

   Every path here is RELATIVE, so the app also works under a sub-path like
   /gh/user/repo@main/public/ or /mkmalik-server/.
   --------------------------------------------------------------------------- */

/** Directory the app was served from, with a trailing slash. */
export const BASE = (() => {
  const url = document.baseURI.split(/[?#]/)[0];
  return url.slice(0, url.lastIndexOf('/') + 1);
})();

/** Absolute-ish URL for a path inside the app (kept relative to the origin). */
export const rel = (p) => BASE + String(p).replace(/^\/+/, '');

/**
 * Where the live server advertises itself, so an app installed from a static
 * host can still reach a real backend that moves around.
 */
export const BACKEND_HINT_URLS = [
  // this branch first (fresh while this session runs), then the default
  // branch (kept fresh by the scheduled live runs long after this session)
  'https://raw.githubusercontent.com/olis71697-hub/mkmalik-server/arena/e87dd7c5-mkmalik-server/backend.json',
  'https://raw.githubusercontent.com/olis71697-hub/mkmalik-server/main/backend.json',
  rel('backend.json'),
];

const sameOrigin = () => rel('api');

// ── discovered state ───────────────────────────────────────────────────────
let backendOrigin = '';           // '' → the app's own origin

export const mode = {
  server: false,          // a real backend answered /api/health
  offline: false,         // nothing answered — the app cannot run
  crossOrigin: false,
  checked: false,
  checkedAt: 0,
  features: null,
};

/** Origin of the live server, or '' when it is this same origin. */
export const getBackend = () => backendOrigin;

/** Base URL for REST calls. */
export const apiBase = () => (backendOrigin ? backendOrigin + '/api' : sameOrigin());

/** Base URL for the Socket.IO script and connection. '' → same origin. */
export const socketBase = () => backendOrigin;

export function setBackend(origin) {
  backendOrigin = origin ? String(origin).replace(/\/+$/, '') : '';
  mode.crossOrigin = !!backendOrigin;
}

const healthUrl = (origin) => (origin ? origin.replace(/\/+$/, '') + '/api/health' : rel('api/health'));

/**
 * Ask a candidate origin whether a real backend lives there.
 * Returns the origin string on success, or '' if nothing answered.
 */
export async function probeBackend(origin, timeoutMs = 4000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(healthUrl(origin), { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return '';

    const data = await res.json().catch(() => null);
    // A static host that answers /api/health with HTML must not fool us.
    if (data && typeof data === 'object' && data.ok !== undefined) {
      if (data.features) mode.features = data.features;
      return origin || sameOrigin();
    }
  } catch (_) { /* nothing here */ }
  return '';
}

/** Look for an advertised backend origin, then check that it answers. */
async function discoverAdvertisedBackend() {
  for (const hintUrl of BACKEND_HINT_URLS) {
    let origin = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(hintUrl, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) continue;

      const text = await res.text();
      let hint = null;
      try { hint = JSON.parse(text); } catch (_) { hint = text.trim(); }
      origin = (hint && typeof hint === 'object' ? hint.backend : hint) || '';
      if (!origin || typeof origin !== 'string' || !/^https?:\/\//.test(origin)) continue;
    } catch (_) {
      continue;
    }

    if (await probeBackend(origin)) {
      setBackend(origin);
      return true;
    }
  }
  return false;
}

/**
 * Decide where the app runs. Order:
 *   1. an explicit ?backend= override (remembered afterwards)
 *   2. a backend on this very origin — the app is being served by the server
 *   3. an advertised backend (static host, moving backend)
 *   4. nowhere → offline: the app says so instead of inventing data
 */
export async function detectMode({ timeoutMs = 3500, force = false } = {}) {
  if (mode.checked && !force) return mode;
  mode.server = false;
  mode.offline = false;

  let override = '';
  try {
    const param = new URLSearchParams(location.search).get('backend');
    if (param) {
      override = param;
      localStorage.setItem('panda.backend', param);
    } else {
      override = localStorage.getItem('panda.backend') || '';
    }
  } catch (_) {}

  if (override && await probeBackend(override, timeoutMs)) {
    setBackend(override);
    mode.server = true;
    mode.checked = true;
    mode.checkedAt = Date.now();
    return mode;
  }

  if (await probeBackend('', timeoutMs)) {
    setBackend('');
    mode.server = true;
    mode.checked = true;
    mode.checkedAt = Date.now();
    return mode;
  }

  if (await discoverAdvertisedBackend()) {
    mode.server = true;
    mode.checked = true;
    mode.checkedAt = Date.now();
    return mode;
  }

  setBackend('');
  mode.offline = true;
  mode.checked = true;
  mode.checkedAt = Date.now();
  return mode;
}

export const isServer = () => mode.server;
export const isOffline = () => mode.offline;
