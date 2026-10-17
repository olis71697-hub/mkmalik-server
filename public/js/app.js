/* Panda Voice — app shell: session, routing, socket lifecycle, page stack. */

import { $, $$, el, toast, bus, haptic, avatarImg, svg, ICON } from './util.js';
import { t, setLang, lang, onLangChange } from './i18n.js';
import { api, session, ApiError } from './api.js';
import { detectMode, isServer, getBackend, rel } from './runtime.js';
import { mountAuth, mountOnboarding } from './screens/auth.js';
import { mountHome } from './screens/home.js';
import { mountDiscover } from './screens/discover.js';
import { mountChat } from './screens/chat.js';
import { mountWallet } from './screens/wallet.js';
import { mountProfile } from './screens/profile.js';
import { openPage } from './screens/extra.js';

/** Shared application context handed to every screen. */
export const App = {
  user: null,
  socket: null,
  online: true,
  events: bus(),
  current: 'home',
  mode: 'server',        // the app only ever runs against the real backend
  wallet: { coins: 0, diamonds: 0 },
  settings: { language: 'bn', theme: 'dark' },
  socketReady: false,
  unread: { notifications: 0, messages: 0 },

  setWallet({ coins, diamonds }) {
    if (coins !== undefined) this.wallet.coins = coins;
    if (diamonds !== undefined) this.wallet.diamonds = diamonds;
    this.events.emit('wallet', this.wallet);
  },

  setUser(user) {
    this.user = user;
    session.set(session.token, user);
    this.events.emit('user', user);
  },
};

// ── routing ────────────────────────────────────────────────────────────────
const screens = ['home', 'discover', 'messages', 'wallet', 'profile'];

export function go(name) {
  if (!screens.includes(name)) name = 'home';
  App.current = name;
  for (const s of screens) {
    const node = $(`.screen[data-screen="${s}"]`);
    if (node) node.hidden = s !== name;
  }
  $$('.tabbar-item').forEach((b) => b.classList.toggle('is-active', b.dataset.go === name));
  App.events.emit('route', name);
  try { history.replaceState(null, '', '#' + name); } catch (_) {}
}

// ── theme / language ───────────────────────────────────────────────────────
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  try { localStorage.setItem('panda.theme', theme); } catch (_) {}
  App.events.emit('theme', theme);
}
function applyStoredTheme() {
  let theme = null;
  try { theme = localStorage.getItem('panda.theme'); } catch (_) {}
  if (!theme) theme = App.settings?.theme || 'dark';
  applyTheme(theme);
}

// ── socket ─────────────────────────────────────────────────────────────────
/** Socket.IO only exists on a Node host, so load it on demand. */
function loadSocketIo() {
  return new Promise((resolve) => {
    if (window.io) return resolve(true);
    const script = document.createElement('script');
    script.src = (getBackend() || rel('')) + 'socket.io/socket.io.js';
    script.onload = () => resolve(!!window.io);
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
}

async function connectSocket() {
  if (App.socket) { try { App.socket.disconnect(); } catch (_) {} App.socket = null; }

  const loaded = await loadSocketIo();
  if (!loaded) {
    toast('রিয়েলটাইম কানেকশন পাওয়া যায়নি — আবার চেষ্টা হচ্ছে', 'err');
    return null;
  }

  const socket = window.io(getBackend() || undefined, {
    auth: { token: session.token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 900,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
  });
  App.socket = socket;

  socket.on('connect', () => {
    App.socketReady = true;
    App.events.emit('socket', { connected: true });
  });
  socket.on('disconnect', (reason) => {
    App.socketReady = false;
    App.events.emit('socket', { connected: false, reason });
  });
  socket.on('connect_error', (err) => {
    App.socketReady = false;
    if (String(err?.message).includes('AUTH')) {
      session.clear();
      showAuth();
    }
  });

  // ---- global pushes ----
  socket.on('notification', (n) => {
    App.unread.notifications++;
    refreshBadges();
    toast(`${n.title}: ${n.body}`, 'ok');
    App.events.emit('notification', n);
  });
  socket.on('dm:new', (p) => {
    App.unread.messages++;
    refreshBadges();
    App.events.emit('dm:new', p);
  });
  socket.on('user:levelup', ({ level }) => levelUpFx(level));
  socket.on('presence:online', (p) => App.events.emit('presence:online', p));

  App.events.emit('socket', { connecting: true });
  return socket;
}

// ── badges ────────────────────────────────────────────────────────────────
export function refreshBadges() {
  const nd = $('#notifDot');
  if (nd) { nd.hidden = App.unread.notifications === 0; nd.textContent = App.unread.notifications > 9 ? '9+' : App.unread.notifications; }
  const cd = $('#chatDot');
  if (cd) { cd.hidden = App.unread.messages === 0; cd.textContent = App.unread.messages > 9 ? '9+' : App.unread.messages; }
  const coins = $('#homeCoins');
  if (coins) coins.textContent = `${App.wallet.coins > 9999 ? (App.wallet.coins / 1000).toFixed(1) + 'K' : App.wallet.coins} 🪙`;
}

// ── level-up celebration ───────────────────────────────────────────────────
function levelUpFx(level) {
  haptic(60);
  const fx = el('div', { class: 'levelup-fx' },
    el('div', { class: 'star', text: '🎉' }),
    el('div', { class: 'txt', text: `${t('notifLevelup')} Level ${level}` }));
  document.body.append(fx);
  setTimeout(() => fx.remove(), 2800);
}

// ── auth flow ──────────────────────────────────────────────────────────────
export function showAuth() {
  $('#app').hidden = true;
  $('#onboarding').hidden = true;
  $('#authScreen').hidden = false;
  mountAuth(App, { onSignedIn });
}

function showOnboarding() {
  $('#app').hidden = true;
  $('#authScreen').hidden = true;
  $('#onboarding').hidden = false;
  mountOnboarding(App, () => {
    try { localStorage.setItem('panda.onboarded', '1'); } catch (_) {}
    showAuth();
  });
}

async function onSignedIn({ user, token, wallet, settings }) {
  session.set(token, user);
  App.user = user;
  if (wallet) App.setWallet(wallet);
  if (settings) {
    App.settings = settings;
    if (settings.language && settings.language !== lang()) setLang(settings.language);
  }
  App.unread = { notifications: 0, messages: 0 };
  refreshBadges();

  $('#authScreen').hidden = true;
  $('#onboarding').hidden = true;
  $('#app').hidden = false;

  // avatar in home topbar
  const ha = $('#homeAvatar');
  ha.innerHTML = '';
  ha.append(avatarImg(user.avatar, user.displayName, 'avatar--sm'));

  mountAllScreens();
  go('home');
  await connectSocket();
  loadUnreadCounts();
}

function mountAllScreens() {
  mountHome(App);
  mountDiscover(App);
  mountChat(App);
  mountWallet(App);
  mountProfile(App);
  // the voice room mounts itself lazily from openRoom() — nothing to do here
}

async function loadUnreadCounts() {
  try {
    const [notif, convs] = await Promise.all([api.notifications(), api.conversations()]);
    App.unread.notifications = notif.unread || 0;
    App.unread.messages = (convs.conversations || []).reduce((s, c) => s + (c.unread || 0), 0);
    refreshBadges();
  } catch (_) {}
}

export async function signOut() {
  try { App.socket?.disconnect(); } catch (_) {}
  App.socket = null;
  App.user = null;
  session.clear();
  toast(t('logout') + ' ✓');
  showAuth();
}

// ── no backend reachable → say so honestly, never fake a working app ──────
function showOffline() {
  let layer = $('#offlineScreen');
  if (layer) { layer.hidden = false; return; }
  layer = el('div', { id: 'offlineScreen', class: 'offline-screen', role: 'alert' },
    el('div', { class: 'offline-card' },
      el('div', { class: 'offline-emoji', text: '📡' }),
      el('h2', { text: 'সার্ভারে পৌঁছানো যাচ্ছে না' }),
      el('p', { text: 'Panda Voice চলে একটি আসল সার্ভার থেকে — নকল ডেটা দেখানো হয় না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।' }),
      el('button', {
        class: 'btn btn--primary', text: '🔄 আবার চেষ্টা করুন',
        onclick: () => location.reload(),
      })));
  document.body.append(layer);
}

// ── install prompt ─────────────────────────────────────────────────────────
let deferredInstall = null;
function setupInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('#installBar').hidden = false;
  });
  $('#installBtn')?.addEventListener('click', async () => {
    $('#installBar').hidden = true;
    if (deferredInstall) {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
    }
  });
  $('#installClose')?.addEventListener('click', () => { $('#installBar').hidden = true; });

  // iOS Safari has no install API — tell the user how to do it manually,
  // but only once and only when running in the browser (not standalone).
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  if (isIOS && !standalone) {
    try {
      if (localStorage.getItem('panda.iosHint') === 'off') return;
    } catch (_) {}
    setTimeout(() => toast('iOS-এ ইনস্টল করতে: Share → Add to Home Screen 🐼'), 2600);
    try { localStorage.setItem('panda.iosHint', 'off'); } catch (_) {}
  }
}

// ── service worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(rel('sw.js')).catch(() => {});
  });
}

// ── global button wiring ───────────────────────────────────────────────────
function wireShell() {
  $$('.tabbar-item').forEach((b) => b.addEventListener('click', () => { haptic(8); go(b.dataset.go); }));
  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.open === 'notifications') openPage.notifications(App);
  }));
  $('#homeSearch')?.addEventListener('click', () => go('discover'));
  $('#discoverCreate')?.addEventListener('click', () => openPage.createRoom(App));
  $('#msgNewChat')?.addEventListener('click', () => openPage.newChat(App));
  $('#walletHelp')?.addEventListener('click', () => openPage.coinInfo(App));
  $$('[data-close]').forEach((elm) => elm.addEventListener('click', () => {
    const sheet = document.getElementById(elm.dataset.close);
    if (sheet) sheet.hidden = true;
  }));

  // keyboard: Esc leaves the room / closes sheets
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['giftSheet', 'sheet']) {
      const s = document.getElementById(id);
      if (s && !s.hidden) { s.hidden = true; return; }
    }
  });
}

// re-render static i18n labels on language change
function refreshStaticText() {
  $$('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
  const tabLabels = { home: t('home'), discover: t('discover'), messages: t('messages'), wallet: t('wallet'), profile: t('profile') };
  $$('.tabbar-item span:first-child').forEach((s) => { s.textContent = tabLabels[s.parentElement.dataset.go] || s.textContent; });
  $('#roomInput')?.setAttribute('placeholder', t('typeMessage'));
  $('#discoverInput')?.setAttribute('placeholder', t('search') + '…');
}

// ── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  applyStoredTheme();
  wireShell();
  setupInstall();
  onLangChange(refreshStaticText);
  refreshStaticText();

  await detectMode();

  // No backend anywhere → an honest error, never a fake app.
  if (!isServer()) {
    hideBoot();
    showOffline();
    return;
  }

  // a saved session?
  if (session.token) {
    try {
      const me = await api.me();
      App.unread = { notifications: 0, messages: 0 };
      await onSignedIn({ user: me.user, token: session.token, wallet: me.wallet, settings: me.settings });
      hideBoot();
      return;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) session.clear();
      else if (e.status === 0) { /* server temporarily unreachable — fall through to auth */ }
    }
  }

  hideBoot();
  let onboarded = false;
  try { onboarded = localStorage.getItem('panda.onboarded') === '1'; } catch (_) {}
  if (onboarded) showAuth();
  else showOnboarding();
}

function hideBoot() {
  const boot = $('#boot');
  if (boot) {
    boot.style.transition = 'opacity .3s';
    boot.style.opacity = '0';
    setTimeout(() => { boot.style.display = 'none'; }, 320);
  }
}

// deep link: #create / action=create opens the create-room page
function handleDeepLinks() {
  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'create' && App.user) {
    setTimeout(() => openPage.createRoom(App), 600);
  }
  // push notification / shared link: ./#room=<id> opens the room directly
  const roomId = (location.hash.match(/^#room=([A-Za-z0-9_-]{6,40})/) || [])[1];
  if (roomId && App.user) {
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => import('./screens/room.js').then(({ openRoom }) => openRoom(App, roomId)), 400);
  }
}
App.events.on('user', () => handleDeepLinks());

boot();
