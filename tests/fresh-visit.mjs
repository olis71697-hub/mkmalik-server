/*
 * MK Malik — integration test: first load.
 *
 * The boot splash must never be the last thing on screen. A visitor with no
 * saved session should either land straight in the app (demo auto-login) or get
 * a working sign-in screen — never a blank page.
 */

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BASE = process.env.BASE_URL || 'http://localhost:8080';

const { ok: healthOk, demoAutoLogin } = await (await fetch(BASE + '/api/health')).json();
if (!healthOk) { console.error('server is not healthy'); process.exit(1); }

// ── boot the real app in a DOM with no stored session ──────────────────────
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
  { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
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
window.io = globalThis.io = () => ({
  id: 'stub', connected: true, on() { return this; }, emit() { return this; }, disconnect() {},
});
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('/') ? BASE + u : u, o);
window.fetch = globalThis.fetch;

window.localStorage.clear();   // a genuinely first-time visitor

await import(path.join(ROOT, 'js/app.js'));
await new Promise((r) => setTimeout(r, 1800));

const $ = (s) => window.document.querySelector(s);
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};

console.log('\n════ FIRST LOAD ════\n');
console.log(`  server demo auto-login: ${demoAutoLogin ? 'on' : 'off'}`);

const boot = $('#boot');
const app = $('#app');

check('boot splash is dismissed', boot.style.display === 'none');
check('app shell is visible', !app.hidden);

if (demoAutoLogin) {
  const cards = window.document.querySelectorAll('#exploreGrid .card').length;
  const tabs = [...window.document.querySelectorAll('#exploreTabs .tab')].map((t) => t.textContent);
  const nav = [...window.document.querySelectorAll('.tabbar-item span')].map((s) => s.textContent);
  check('visitor lands on the Explore design without signing in', cards > 0, `${cards} room cards`);
  check('design chrome is present',
    tabs.join('/') === 'Related/Hot/Explore' && nav.join('/') === 'Explore/Moments/Chat/Profile',
    `${tabs.join(' · ')} | ${nav.join(' · ')}`);
} else {
  const auth = $('#authScreen');
  check('sign-in screen is shown', !!auth);
  if (auth) {
    const fields = [...auth.querySelectorAll('.field label')].map((l) => l.textContent);
    check('sign-in form is usable', fields.join('/') === 'Username/Password', fields.join(' · '));
  }
}

// no runtime errors during boot
const fatal = [];
window.addEventListener('error', (e) => fatal.push(e.message));
await new Promise((r) => setTimeout(r, 300));
check('no fatal errors during boot', fatal.length === 0, fatal.slice(0, 2).join('; '));

console.log(`\n════ RESULT: ${pass} passed, ${fail} failed ════\n`);
process.exit(fail ? 1 : 0);
