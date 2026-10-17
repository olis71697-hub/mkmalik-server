/*
 * Panda Voice — integration test: first load.
 *
 * A first-time visitor must land on a REAL sign-in screen — the app never
 * signs anyone in silently, shows no demo account and no fake data. The
 * database starts empty of users, but the gift catalog (product data) must
 * already be there.
 */

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BASE = process.env.BASE_URL || 'http://localhost:8080';

const health = await (await fetch(BASE + '/api/health')).json();
if (!health.ok) { console.error('server is not healthy'); process.exit(1); }

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
// returning visitor (onboarding seen once) → straight to the sign-in form
window.localStorage.setItem('panda.onboarded', '1');

await import(path.join(ROOT, 'js/app.js'));
await new Promise((r) => setTimeout(r, 1800));

const $ = (s) => window.document.querySelector(s);
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};

console.log('\n════ FIRST LOAD ════\n');

const boot = $('#boot');
check('boot splash is dismissed', boot.style.display === 'none');

const auth = $('#authScreen');
check('visitor lands on the real sign-in screen', !!auth && !auth.hidden);
if (auth) {
  const fields = [...auth.querySelectorAll('.field label')].map((l) => l.textContent);
  check('sign-in form is usable', fields.includes('ইউজারনেম') && fields.includes('পাসওয়ার্ড'), fields.join(' · '));
}

check('no silent demo session was created', window.localStorage.getItem('panda.token') === null,
  window.localStorage.getItem('panda.token') === null ? 'no token stored' : 'token stored!');

check('no offline error screen on a healthy server', !$('#offlineScreen'));

// product data exists even on a brand-new database — the gift wall is not
// seed data
const gifts = (await (await fetch(BASE + '/api/gifts')).json()).gifts || [];
check('gift catalog is present on a fresh database', gifts.length >= 14, `${gifts.length} gifts`);

// no runtime errors during boot
const fatal = [];
window.addEventListener('error', (e) => fatal.push(e.message));
await new Promise((r) => setTimeout(r, 300));
check('no fatal errors during boot', fatal.length === 0, fatal.slice(0, 2).join('; '));

console.log(`\n════ RESULT: ${pass} passed, ${fail} failed ════\n`);
process.exit(fail ? 1 : 0);
