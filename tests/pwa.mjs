/*
 * MK Malik — integration test: PWA installability.
 *
 * Checks the pieces a browser needs before it will offer to install the app:
 * a valid manifest, reachable icons, a registered service worker, and the
 * head tags that make iOS treat it as a standalone app.
 */

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BASE = process.env.BASE_URL || 'http://localhost:8080';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};

console.log('\n════ PWA / INSTALLABLE ════\n');

// ── manifest ───────────────────────────────────────────────────────────────
const manRes = await fetch(BASE + '/manifest.webmanifest');
const man = await manRes.json();
check('manifest is served as manifest+json',
  /manifest\+json/.test(manRes.headers.get('content-type') || ''), manRes.headers.get('content-type'));
check('has name and short_name', !!man.name && !!man.short_name, `${man.short_name}`);
check('display is standalone', man.display === 'standalone', man.display);
check('start_url is in scope', man.start_url?.startsWith('/') && man.scope === '/', `${man.start_url} scope ${man.scope}`);
check('theme_color matches the design', man.theme_color === '#ff5a1f', man.theme_color);

const purposes = (man.icons || []).map((i) => i.purpose || 'any');
check('declares 192 and 512 icons',
  (man.icons || []).some((i) => i.sizes === '192x192') && (man.icons || []).some((i) => i.sizes === '512x512'),
  (man.icons || []).map((i) => i.sizes).join(', '));
check('includes a maskable icon (Android adaptive)', purposes.includes('maskable'));
check('declares at least two shortcuts', (man.shortcuts || []).length >= 2,
  (man.shortcuts || []).map((s) => s.name).join(', '));

// every declared icon must actually exist and be a real PNG
for (const icon of man.icons || []) {
  const res = await fetch(BASE + icon.src);
  const buf = Buffer.from(await res.arrayBuffer());
  const isPng = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const w = buf.length > 24 ? buf.readUInt32BE(16) : 0;
  const h = buf.length > 24 ? buf.readUInt32BE(20) : 0;
  check(`${icon.src} is a ${icon.sizes} PNG`, res.ok && isPng && `${w}x${h}` === icon.sizes, `${w}x${h}`);
}

// ── service worker ─────────────────────────────────────────────────────────
const swRes = await fetch(BASE + '/sw.js');
const swText = await swRes.text();
check('service worker is served at /sw.js', swRes.ok);
check('service worker never caches live room data',
  swText.includes('/api/') && swText.includes('/socket.io/') && swText.includes('isRealtime'));
check('service worker has an offline shell fallback', swText.includes("caches.match('/index.html')"));
check('service worker cleans up old versions', swText.includes('caches.keys()') && swText.includes('caches.delete'));

// ── head tags ──────────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('links the manifest', /rel="manifest"\s+href="\/manifest\.webmanifest"/.test(html));
check('has an apple-touch-icon for iOS', /rel="apple-touch-icon"/.test(html));
check('declares apple-mobile-web-app-capable', /apple-mobile-web-app-capable"\s+content="yes"/.test(html));
check('theme-color is the brand orange', /name="theme-color"\s+content="#ff5a1f"/.test(html));
check('has an in-app install prompt', /id="installBar"/.test(html) && /id="installBtn"/.test(html));

// ── the app registers the worker ───────────────────────────────────────────
const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
check('app registers the service worker', /serviceWorker\.register\('\/sw\.js'\)/.test(appJs));
check('app handles beforeinstallprompt', appJs.includes('beforeinstallprompt'));
check('app handles iOS (no install API)', appJs.includes('Add to Home Screen'));

// ── a boot in a DOM still succeeds with the PWA wiring ─────────────────────
const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
globalThis.location = window.location;
globalThis.history = window.history;
globalThis.localStorage = window.localStorage;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Node = window.Node;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
window.io = globalThis.io = () => ({ id: 'x', connected: true, on() { return this; }, emit() { return this; }, disconnect() {} });
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('/') ? BASE + u : u, o);
window.fetch = globalThis.fetch;
window.localStorage.clear();

await import(path.join(ROOT, 'js/app.js'));
await new Promise((r) => setTimeout(r, 1500));

const cards = window.document.querySelectorAll('#exploreGrid .card').length;
check('app still boots and renders with PWA wiring', cards > 0, `${cards} room cards`);
check('install bar exists in the DOM', !!window.document.querySelector('#installBar'));

console.log(`\n════ RESULT: ${pass} passed, ${fail} failed ════\n`);
process.exit(fail ? 1 : 0);
