/* App shell — session, routing, socket lifecycle, screen mounting. */

import { $, $$, el, toast, bus, svg, ICON, haptic } from './util.js';
import { api, session, ApiError } from './api.js';
import { mountExplore }   from './screens/explore.js';
import { mountMoments }   from './screens/moments.js';
import { mountChat }      from './screens/chat.js';
import { mountProfile }   from './screens/profile.js';
import { mountRoom }      from './screens/room.js';
import { mountAuth }      from './screens/auth.js';

/** Shared application context handed to every screen. */
export const App = {
  user: null,
  socket: null,
  online: true,
  events: bus(),
  current: 'explore',
  wallet: { coins: 0, diamonds: 0 },
  socketReady: false,

  setWallet({ coins, diamonds }) {
    if (coins !== undefined) this.wallet.coins = coins;
    if (diamonds !== undefined) this.wallet.diamonds = diamonds;
    this.events.emit('wallet', this.wallet);
  },
};

// ── routing ────────────────────────────────────────────────────────────────
const screens = ['explore', 'moments', 'chat', 'profile'];

export function go(name) {
  if (!screens.includes(name)) name = 'explore';
  App.current = name;
  for (const s of screens) {
    const node = $(`.screen[data-screen="${s}"]`);
    if (node) node.hidden = s !== name;
  }
  $$('.tabbar-item').forEach((b) => b.classList.toggle('is-active', b.dataset.go === name));
  App.events.emit('route', name);
  try { history.replaceState(null, '', '#' + name); } catch (_) {}
}

// ── socket ─────────────────────────────────────────────────────────────────
function connectSocket() {
  if (App.socket) { App.socket.disconnect(); App.socket = null; }
  const socket = io({ auth: { token: session.token }, transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    App.socketReady = true;
    App.events.emit('socket', { connected: true });
    if (!App.online) { App.online = true; toast('Back online', 'ok'); }
  });
  socket.on('disconnect', (reason) => {
    App.socketReady = false;
    App.events.emit('socket', { connected: false, reason });
  });
  socket.on('connect_error', (err) => {
    App.events.emit('socket-error', err.message);
    if (err.message === 'AUTH_FAILED' || err.message === 'AUTH_REQUIRED') {
      session.clear();
      showAuth();
    }
  });

  socket.on('ready', ({ user, seats }) => {
    App.user = { ...App.user, ...user };
    App.setWallet(user);
    App.seats = seats;
    App.events.emit('user', App.user);
  });

  socket.on('notification', (n) => {
    toast(n.title ? `${n.title} — ${n.body}` : n.body);
  });

  // global heartbeat → keeps presence + room membership alive
  const beat = setInterval(() => {
    if (App.socket?.connected) App.socket.emit('presence:ping');
  }, 20_000);

  socket.on('disconnect', () => clearInterval(beat));

  App.socket = socket;
  return socket;
}

// ── auth flow ──────────────────────────────────────────────────────────────
/** Reveal the shell and hide the boot splash. Safe to call repeatedly. */
function revealShell() {
  const boot = $('#boot');
  if (boot) boot.style.display = 'none';
  const app = $('#app');
  if (app) app.hidden = false;
}

export function showAuth() {
  const existing = $('#authScreen');
  if (existing) { revealShell(); return; }
  const node = mountAuth({
    async onSubmit(mode, username, password, displayName) {
      const data = mode === 'register'
        ? await api.register(username, password, displayName)
        : await api.login(username, password);
      session.set(data.token, data.user);
      node.remove();
      await start();
    },
  });
  document.getElementById('app').append(node);
  revealShell();
}

async function start() {
  revealShell();

  // load the profile before anything renders so the UI never flickers empty
  try {
    const { user, wallet } = await api.me();
    App.user = user;
    App.setWallet(wallet);
  } catch (e) {
    if (e.status === 401) { session.clear(); showAuth(); return; }
    toast(e.message, 'err');
  }

  connectSocket();
  App.events.emit('started', App);
}

// screens ask for navigation through the shared event bus
App.events.on('route:go', (name) => go(name));

// ── global UI wiring ───────────────────────────────────────────────────────
function wireChrome() {
  $$('.tabbar-item').forEach((btn) => {
    btn.addEventListener('click', () => { haptic(); go(btn.dataset.go); });
  });

  document.addEventListener('click', (ev) => {
    const closer = ev.target.closest('[data-close]');
    if (closer) {
      const sheet = document.getElementById(closer.dataset.close);
      if (sheet) sheet.hidden = true;
    }
  });

  // room chrome
  $('#roomBack')?.addEventListener('click', () => App.events.emit('room:leave-request'));

  // create-room action (also used by the empty state)
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action="create-room"]');
    if (btn) { ev.preventDefault(); App.events.emit('create-room'); }
  });

  window.addEventListener('online', () => { App.online = true; App.events.emit('net', true); });
  window.addEventListener('offline', () => { App.online = false; App.events.emit('net', false); toast('You are offline', 'err'); });

  document.addEventListener('visibilitychange', () => {
    App.events.emit('visibility', !document.hidden);
  });
}

// ── installable app ────────────────────────────────────────────────────────
function wireInstall() {
  // Register the service worker so the app can be installed to the home
  // screen. Voice still needs HTTPS, which any real deployment provides.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((e) => {
        console.warn('[pwa] service worker registration failed:', e.message);
      });
    });
  }

  const bar = $('#installBar');
  const dismissed = (() => { try { return localStorage.getItem('mkmalik.install.dismissed') === '1'; } catch (_) { return false; } })();
  let deferredPrompt = null;

  const hide = () => { if (bar) bar.hidden = true; };

  // Chrome / Edge / Android: the browser hands us the prompt to fire later.
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    deferredPrompt = ev;
    if (!dismissed) hide(); // ensure clean state before showing
    if (!dismissed) setTimeout(() => { if (bar) bar.hidden = false; }, 600);
  });

  window.addEventListener('appinstalled', () => {
    hide();
    try { localStorage.setItem('mkmalik.install.dismissed', '1'); } catch (_) {}
    toast('Installed — open MK Malik from your home screen 🎉', 'ok');
  });

  $('#installBtn')?.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      hide();
      if (outcome !== 'accepted') toast('You can install any time from the browser menu');
      return;
    }
    // iOS Safari and others have no install API — explain the manual route.
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua)) {
      toast('Tap the Share button, then "Add to Home Screen"', 'ok');
    } else {
      toast('Open the browser menu and choose "Install app" / "Add to Home screen"', 'ok');
    }
  });

  $('#installClose')?.addEventListener('click', () => {
    hide();
    try { localStorage.setItem('mkmalik.install.dismissed', '1'); } catch (_) {}
  });
}

// ── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  wireChrome();
  wireInstall();
  mountExplore(App);
  mountMoments(App);
  mountChat(App);
  mountProfile(App);
  mountRoom(App);
  go('explore');

  const hash = location.hash.replace('#', '');
  if (screens.includes(hash)) go(hash);

  // manifest shortcut: "Open a room"
  if (new URLSearchParams(location.search).get('action') === 'create') {
    setTimeout(() => App.events.emit('create-room'), 400);
  }

  if (session.token) { await start(); return; }

  // No saved session. On a demo/showcase deployment we drop the visitor
  // straight into the seeded account so the app is usable immediately;
  // otherwise they get the sign-in screen.
  try {
    const data = await api.demo();
    session.set(data.token, data.user);
    await start();
    toast('Demo mode — sign out from Profile to use your own account');
    return;
  } catch (_) {
    // demo disabled or unavailable → normal sign-in
  }
  showAuth();
}

// Never leave the user staring at a splash screen. Runs even if boot() itself
// fails, because it is registered before boot() is invoked below.
function installBootGuard() {
  const show = (heading, detail) => {
    const boot = $('#boot');
    if (!boot || boot.style.display === 'none') return;
    boot.innerHTML = '';
    boot.append(
      el('div', { class: 'boot-logo', text: '⚠️' }),
      el('div', { class: 'boot-name', text: heading }),
      el('div', { class: 'boot-sub', style: { maxWidth: '300px', textAlign: 'center' }, text: detail }),
      el('button', {
        class: 'btn btn--primary', style: { marginTop: '18px' },
        text: 'Retry', onclick: () => location.reload(),
      }),
    );
  };
  window.addEventListener('error', (e) => show('Could not start', e.message || 'Unknown error'));
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason?.message || String(e.reason || 'Unknown error');
    show('Could not start', msg);
  });
  // Hard deadline: if the app has not revealed itself, say so rather than hang.
  setTimeout(() => {
    const boot = $('#boot');
    if (boot && boot.style.display !== 'none') {
      show('Taking too long', 'The app did not finish loading. Check your connection and retry.');
    }
  }, 12_000);
}

window.__mkmalik = { App, go, toast, api };

// Installed before boot() so a failure inside boot() can still be surfaced.
installBootGuard();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

// surface unexpected errors instead of dying silently
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || '';
  if (msg && !/play\(\) request was interrupted|AbortError/.test(msg)) console.warn('[app]', msg);
});
