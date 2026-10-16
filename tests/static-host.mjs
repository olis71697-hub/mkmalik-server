/* ---------------------------------------------------------------------------
   Static-host / sub-path test.

   The app is published to GitHub Pages under a sub-path
   (https://<user>.github.io/<repo>/), where:
     • there is no backend, so every /api call must fail and trigger local mode
     • every asset reference must be relative, or it 404s

   This suite starts a throwaway "Pages-like" server that serves public/ under
   /mkmalik-server/ and returns a 404 for /api/*, then walks the real asset and
   ES-module graph exactly as a browser would. If every hop resolves 200, the
   sub-path deployment is sound.
   --------------------------------------------------------------------------- */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const PREFIX = '/mkmalik-server/';
const r = makeReporter('static host · sub-path deployment');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
};

// ── a stand-in for GitHub Pages ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);

  // Pages has no backend: anything under /api returns its 404 page.
  if (p.includes('/api/') || p.includes('/socket.io/')) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    return res.end('<!DOCTYPE html><title>404</title><h1>Not Found</h1>');
  }

  // No trailing slash: Pages issues a redirect to the directory.
  if (p === PREFIX.slice(0, -1)) { res.writeHead(301, { Location: PREFIX }); return res.end(); }
  if (p === PREFIX) p = PREFIX + 'index.html';

  if (!p.startsWith(PREFIX)) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    return res.end('<!DOCTYPE html><title>404</title>');
  }

  const rel = p.slice(PREFIX.length);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    return res.end('<!DOCTYPE html><title>404</title>');
  }

  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const ROOT = `http://127.0.0.1:${port}${PREFIX}`;
const get = (u) => fetch(u, { redirect: 'follow' });

try {
  // ── 1. the page itself ───────────────────────────────────────────────────
  r.section('page is served under a sub-path');
  const pageRes = await get(ROOT);
  const html = await pageRes.text();
  r.check('sub-path index returns 200', pageRes.status === 200, `${ROOT} → ${pageRes.status}`);
  r.check('directory redirects to a trailing slash', (await fetch(ROOT.slice(0, -1), { redirect: 'manual' })).status === 301);

  // ── 2. no absolute asset paths ───────────────────────────────────────────
  r.section('asset references are relative');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  const absolute = refs.filter((u) => u.startsWith('/') || /^https?:/.test(u));
  r.check('index.html has no absolute paths', absolute.length === 0, absolute.join(', ') || 'none');
  r.check('references the manifest relatively', refs.includes('manifest.webmanifest'));

  // ── 3. every referenced asset resolves ───────────────────────────────────
  r.section('every referenced asset resolves');
  const assetHops = refs.filter((u) => !u.startsWith('#') && !/^https?:|^data:/.test(u));
  let assetOk = 0;
  for (const u of assetHops) {
    const res = await get(new URL(u, ROOT).href);
    if (res.ok) assetOk++; else r.check(`asset ${u}`, false, `HTTP ${res.status}`);
  }
  r.check(`all ${assetHops.length} page assets return 200`, assetOk === assetHops.length, `${assetOk}/${assetHops.length}`);

  // ── 4. walk the ES-module graph ──────────────────────────────────────────
  // A single bad relative import under a sub-path breaks the whole app, and
  // nothing else in the suite would catch it.
  r.section('ES module graph resolves');
  const seen = new Set();
  const queue = [...assetHops.filter((u) => u.endsWith('.js'))];
  let modules = 0, broken = [];
  while (queue.length) {
    const rel = queue.shift();
    const abs = new URL(rel, ROOT).href;
    if (seen.has(abs)) continue;
    seen.add(abs);

    const res = await get(abs);
    if (!res.ok) { broken.push(`${rel} → HTTP ${res.status}`); continue; }
    modules++;

    const src = await res.text();
    const base = new URL('.', abs).href;
    // static imports, dynamic imports and import-ish string literals
    const specs = [
      ...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);

    for (const spec of specs) {
      if (/^https?:|^data:/.test(spec)) continue;
      queue.push(new URL(spec, base).href.slice(ROOT.length));
    }
  }
  r.check('no broken imports anywhere in the graph', broken.length === 0, broken.join(' | ') || `${modules} modules all resolved`);
  r.check('the whole module graph was walked', modules >= 9, `${modules} modules`);

  // ── 5. manifest survives the sub-path ────────────────────────────────────
  r.section('web app manifest');
  const man = await (await get(ROOT + 'manifest.webmanifest')).json();
  r.check('start_url stays inside the app', !man.start_url.startsWith('/'), `start_url="${man.start_url}"`);
  r.check('scope stays inside the app', man.scope === './' || !man.scope.startsWith('/'), `scope="${man.scope}"`);
  const startAbs = new URL(man.start_url, ROOT).href;
  r.check('start_url resolves into the sub-path', startAbs.startsWith(ROOT), startAbs);

  let iconOk = 0, iconTotal = 0;
  const icons = [...man.icons, ...man.shortcuts.flatMap((s) => s.icons || [])];
  for (const icon of icons) {
    iconTotal++;
    const res = await get(new URL(icon.src, ROOT).href);
    if (res.ok && (res.headers.get('content-type') || '').includes('png')) iconOk++;
    else r.check(`icon ${icon.src}`, false, `HTTP ${res.status}`);
  }
  r.check(`all ${iconTotal} manifest icons resolve as PNG`, iconOk === iconTotal, `${iconOk}/${iconTotal}`);

  // ── 6. service worker ────────────────────────────────────────────────────
  r.section('service worker');
  const swUrl = ROOT + 'sw.js';
  const swRes = await get(swUrl);
  const swText = await swRes.text();
  r.check('sw.js is served', swRes.ok, `HTTP ${swRes.status}`);

  const shellList = (swText.match(/SHELL_FILES\s*=\s*\[([^\]]+)\]/) || [])[1] || '';
  const shellFiles = [...shellList.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  r.check('sw shell list uses relative paths', shellFiles.length > 0 && shellFiles.every((f) => !f.startsWith('/')), shellFiles.join(', '));

  const outOfScope = shellFiles.filter((f) => !new URL(f, swUrl).href.startsWith(ROOT));
  r.check('every shell file stays inside the worker scope', outOfScope.length === 0, outOfScope.join(', ') || 'in scope');

  for (const f of shellFiles) {
    const res = await get(new URL(f, swUrl).href);
    if (!res.ok) r.check(`shell file ${f}`, false, `HTTP ${res.status}`);
  }

  // ── 7. no backend → the app must fall back to local mode ─────────────────
  r.section('graceful fallback with no backend');
  const health = await get(ROOT + 'api/health');
  r.check('/api/health is not a JSON 200 on a static host',
    !(health.ok && (health.headers.get('content-type') || '').includes('json')),
    `HTTP ${health.status} ${health.headers.get('content-type')}`);

  const appSrc = await (await get(ROOT + 'js/app.js')).text();
  r.check('app.js probes for a backend before signing in', /detectMode\(\)/.test(appSrc));
  r.check('app.js switches to the local engine', /isLocal\(\)/.test(appSrc) && /LocalSocket/.test(appSrc));
  // socket.io's client script is not published to a static host, so it must
  // only be requested after the backend check has passed.
  const connectFn = appSrc.slice(appSrc.indexOf('async function connectSocket'));
  const localBranch = connectFn.indexOf('if (isLocal())');
  const loadIo = connectFn.indexOf('loadSocketIo()');
  r.check('app.js only loads socket.io when a backend exists',
    localBranch > -1 && loadIo > localBranch && connectFn.slice(localBranch, loadIo).includes('return'),
    `local branch at ${localBranch}, socket.io load at ${loadIo}`);

  const localSrc = await (await get(ROOT + 'js/local.js')).text();
  r.check('the local engine seeds rooms', /ROOM_SEED/.test(localSrc) && /buildSeed/.test(localSrc));
  r.check('the local engine keeps state on the device', /localStorage/.test(localSrc));
  r.check('the local engine mirrors between tabs', /BroadcastChannel/.test(localSrc));
  r.check('the local engine answers seat:take', /case 'seat:take'/.test(localSrc));
  r.check('the local engine caps rooms at 10 seats', /seats.findIndex\(\(s\) => !s\)/.test(localSrc));
} finally {
  server.close();
}

process.exit(r.finish() ? 0 : 1);
