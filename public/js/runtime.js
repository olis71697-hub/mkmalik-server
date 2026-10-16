/* ---------------------------------------------------------------------------
   Runtime detection.

   The app ships in one piece but can run two ways:

   • server mode — a Node backend answers /api and serves Socket.IO. This is
     the real thing: real rooms, real people, real peer-to-peer voice.

   • local mode — no backend reachable (e.g. the app is hosted on a plain
     static host). Everything runs in the browser from a seeded dataset so the
     app is still fully explorable and installable.

   Every path here is RELATIVE, so the app works both at a domain root and
   under a sub-path like /mkmalik-server/.
   --------------------------------------------------------------------------- */

/** Directory the app was served from, with a trailing slash. */
export const BASE = (() => {
  const url = document.baseURI.split(/[?#]/)[0];
  return url.slice(0, url.lastIndexOf('/') + 1);
})();

/** Absolute-ish URL for a path inside the app (kept relative to the origin). */
export const rel = (p) => BASE + String(p).replace(/^\/+/, '');

export const API_BASE = rel('api');

export const mode = {
  server: false,
  local: false,
  checked: false,
};

/**
 * Decide which mode we are in. A 200 from /api/health means a real backend.
 * Anything else — 404 from a static host, a network error, GitHub Pages
 * serving its own 404 page — means local mode.
 */
export async function detectMode({ timeoutMs = 3500 } = {}) {
  if (mode.checked) return mode;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(API_BASE + '/health', { signal: ctrl.signal });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json().catch(() => null);
      // A static host that happens to return HTML for /api/health must not
      // be mistaken for our backend.
      if (data && typeof data === 'object' && data.ok !== undefined) {
        mode.server = true;
        mode.demoAutoLogin = !!data.demoAutoLogin;
      }
    }
  } catch (_) {
    /* no backend — fall through to local mode */
  }

  if (!mode.server) mode.local = true;
  mode.checked = true;
  return mode;
}

export const isLocal = () => mode.local;
export const isServer = () => mode.server;
