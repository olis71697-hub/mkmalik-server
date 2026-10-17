/* ---------------------------------------------------------------------------
   Panda Voice service worker.

   Deliberately conservative: this app is realtime and every request carries
   live data, so the worker never caches HTML or API responses. It exists to
   make the app installable, to serve the shell when the network drops, and to
   keep the icons fast.
   --------------------------------------------------------------------------- */

const VERSION = 'panda-v2';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

// relative, so the app works at a domain root and under a sub-path
const SHELL_FILES = ['./', './index.html', './css/panda.css', './manifest.json'];
const ASSET_FILES = [
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    // individual adds: a single 404 must not abort the whole install
    await Promise.all(SHELL_FILES.map((f) => shell.add(f).catch(() => {})));
    const assets = await caches.open(ASSETS);
    await Promise.all(ASSET_FILES.map((f) => assets.add(f).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isRealtime(url) {
  return url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/socket.io/')
    || url.pathname.startsWith('/uploads/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live data and media always go to the network — never serve a stale room.
  if (isRealtime(url)) return;

  // API paths are relative to the app, not the origin
  if (url.pathname.includes('/api/') || url.pathname.includes('/socket.io/')) return;

  // Navigations: network first, fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (_) {
        const cached = await caches.match('./index.html') || await caches.match('./');
        return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // Icons and the manifest: cache first, they rarely change.
  if (/\.(?:png|json|webmanifest|ico)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const res = await fetch(request);
        if (res.ok) (await caches.open(ASSETS)).put(request, res.clone());
        return res;
      } catch (_) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // JS/CSS: network first so a deploy is picked up immediately.
  if (/\.(?:js|css)$/.test(url.pathname)) {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (_) {
        const cached = await caches.match(request);
        return cached || new Response('', { status: 504 });
      }
    })());
  }
});

// Let the page tell the worker to take over immediately after an update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});


// ── Web Push (VAPID) ───────────────────────────────────────────────────────
// The server sends { title, body, tag, url }; show it even with no page open.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = data.title || 'Panda Voice 🐼';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || 'panda-voice',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-64.png',
    vibrate: [80, 40, 80],
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('focus' in client) { client.navigate?.(url).catch(() => {}); return client.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
