/*
 * Regression test — a first-time visitor with no saved session must see the
 * sign-in screen. The boot splash must never trap the user on a blank screen.
 */
/* Simulates a brand-new visitor: no token, no localStorage. */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BASE = process.env.BASE_URL || 'http://localhost:8080';
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
window.io = globalThis.io = () => ({ id: 'x', connected: true, on() { return this; }, emit() { return this; }, disconnect() {} });
const rf = globalThis.fetch;
globalThis.fetch = (u, o) => rf(u.startsWith('/') ? BASE + u : u, o);
window.fetch = globalThis.fetch;

// nothing stored = truly first visit
window.localStorage.clear();

await import(path.join(ROOT, 'js/app.js'));
await new Promise((r) => setTimeout(r, 900));

const $ = (s) => window.document.querySelector(s);
const boot = $('#boot');
const app = $('#app');
const auth = $('#authScreen');

console.log('\n── FRESH VISIT (no saved session) ─────────────');
console.log('  splash visible :', boot.style.display !== 'none' ? '❌ STILL SHOWING' : '✅ hidden');
console.log('  app shell      :', app.hidden ? '❌ still hidden' : '✅ visible');
console.log('  login screen   :', auth ? '✅ rendered' : '❌ missing');

if (auth) {
  const title = auth.querySelector('.auth-title')?.textContent;
  const fields = [...auth.querySelectorAll('.field label')].map((l) => l.textContent);
  const btn = auth.querySelector('button[type=submit]')?.textContent;
  const demo = auth.querySelector('.auth-demo')?.textContent.replace(/\s+/g, ' ').trim();
  console.log('  heading        :', title);
  console.log('  fields         :', JSON.stringify(fields));
  console.log('  submit button  :', btn);
  console.log('  demo hint      :', demo);
}

const ok = boot.style.display === 'none' && !app.hidden && !!auth;
console.log('\n' + (ok ? '✅ first-time visitors now see the login screen' : '❌ splash still traps the user'));

// also verify the sign-up switch works
if (auth) {
  const sw = [...auth.querySelectorAll('.auth-switch button')][0];
  sw?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  const fields2 = [...auth.querySelectorAll('.field label')].map((l) => l.textContent);
  console.log('  after tapping switch →', JSON.stringify(fields2));
}

process.exit(ok ? 0 : 1);
