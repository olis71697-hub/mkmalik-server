/*
 * Panda Voice — integration test: PWA installability.
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
const manRes = await fetch(BASE + '/manifest.json');
const man = await manRes.json();
// Chrome accepts application/manifest+json or application/json and ignores
// anything else — which is how a perfectly good manifest quietly stops the
// install prompt from ever appearing.
const manType = (manRes.headers.get('content-type') || '').toLowerCase();
check('manifest is served with a JSON content type',
  manType.includes('manifest+json') || manType.includes('application/json'), manType);
check('has name and short_name', !!man.name && !!man.short_name, `${man.short_name}`);
check('display is standalone', man.display === 'standalone', man.display);
// relative on purpose: the app is also published under a sub-path
check('start_url is relative so a sub-path deploy works',
  man.start_url?.startsWith('./') && man.scope === './', `${man.start_url} scope ${man.scope}`);
// a file CDN answers a bare directory with its own listing, so name the file
check('start_url names index.html so a file host works too',
  /index\.html/.test(man.start_url || ''), man.start_url);
check('shortcuts stay inside the app',
  (man.shortcuts || []).every((s) => s.url.startsWith('./index.html')),
  (man.shortcuts || []).map((s) => s.url).join(', '));
check('manifest icons are relative', man.icons?.every((i) => !i.src.startsWith('/')),
  (man.icons || []).map((i) => i.src).join(', '));
check('theme_color matches the design', man.theme_color === '#0a0f0d', man.theme_color);

const purposes = (man.icons || []).map((i) => i.purpose || 'any');
check('declares 192 and 512 icons',
  (man.icons || []).some((i) => i.sizes === '192x192') && (man.icons || []).some((i) => i.sizes === '512x512'),
  (man.icons || []).map((i) => i.sizes).join(', '));
check('includes a maskable icon (Android adaptive)', purposes.includes('maskable'));
check('declares at least two shortcuts', (man.shortcuts || []).length >= 2,
  (man.shortcuts || []).map((s) => s.name).join(', '));

// every declared icon must actually exist and be a real PNG
const allIcons = [...(man.icons || []), ...(man.shortcuts || []).flatMap((sc) => sc.icons || [])];
for (const icon of allIcons) {
  const res = await fetch(new URL(icon.src, BASE + '/'));
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
check('service worker has an offline shell fallback',
  swText.includes("caches.match('./index.html')") || swText.includes("caches.match('/index.html')"));
check('service worker ignores api paths wherever they are mounted',
  swText.includes("includes('/api/')"));
check('service worker cleans up old versions', swText.includes('caches.keys()') && swText.includes('caches.delete'));

// ── head tags ──────────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('links the manifest', /rel="manifest"\s+href="manifest\.json"/.test(html));
check('index.html has no absolute asset paths', !/(?:href|src)="\//.test(html));
check('has an apple-touch-icon for iOS', /rel="apple-touch-icon"/.test(html));
check('declares apple-mobile-web-app-capable', /apple-mobile-web-app-capable"\s+content="yes"/.test(html));
check('theme-color is the brand green-dark', /name="theme-color"\s+content="#0a0f0d"/.test(html));
check('has an in-app install prompt', /id="installBar"/.test(html) && /id="installBtn"/.test(html));

// ── the app registers the worker ───────────────────────────────────────────
const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
// registered through rel() so it resolves both at a domain root and under a sub-path
check('app registers the service worker',
  /serviceWorker\.register\(rel\('sw\.js'\)\)/.test(appJs), 'rel(\'sw.js\')');
check('app handles beforeinstallprompt', appJs.includes('beforeinstallprompt'));
// ── the in-app download page ───────────────────────────────────────────────
check('app exposes the native install trigger', /export (async )?function triggerInstall/.test(appJs) && /export function installAvailable/.test(appJs));
const extraSrc = fs.readFileSync(path.join(ROOT, 'js/screens/extra.js'), 'utf8');
check('settings links to a download/install page',
  /openPage\.install =/.test(extraSrc) && extraSrc.includes('downloadApp'));
check('the download page fires the native prompt when available', extraSrc.includes('triggerInstall'));
check('the download page covers browsers without a prompt (manual steps)',
  extraSrc.includes('manualStepsTitle') && extraSrc.includes('Add to Home Screen'));
check('already-installed users see a clear state', extraSrc.includes('alreadyInstalled') && extraSrc.includes('standalone'));
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

const bootOk = window.document.querySelector('#boot')?.style.display === 'none';
const landed = !window.document.querySelector('#authScreen')?.hidden
  || !window.document.querySelector('#onboarding')?.hidden;
check('app still boots and renders with PWA wiring', bootOk && landed, landed ? 'sign-in flow reached' : 'nothing visible');
check('install bar exists in the DOM', !!window.document.querySelector('#installBar'));

console.log(`\n════ RESULT: ${pass} passed, ${fail} failed ════\n`);
process.exit(fail ? 1 : 0);
