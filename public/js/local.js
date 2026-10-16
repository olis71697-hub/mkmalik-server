/* ---------------------------------------------------------------------------
   Local engine.

   Runs the whole app in the browser when no backend is reachable — for a
   static host like GitHub Pages, or when the server is down. It provides:

     • localApi   — same method surface as ../api.js
     • LocalSocket — same emit/on surface as Socket.IO, so the room screen,
                     seat logic and chat code work unchanged

   State lives in localStorage and is mirrored between tabs of the same browser
   over BroadcastChannel, so two tabs behave like two people in one room.
   --------------------------------------------------------------------------- */

import { coverFor, CATEGORIES } from './util.js';
import { BASE } from './runtime.js';

const DB_KEY = 'mkmalik.local.db.v1';
const SESSION_KEY = 'mkmalik.local.uid';
const CHANNEL = 'mkmalik.local';

const now = () => Date.now();
const uid = () => Math.random().toString(36).slice(2, 12);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── avatars ────────────────────────────────────────────────────────────────
const GRADIENTS = [
  ['#ff8a3d', '#ff2d78'], ['#7b5cff', '#25d0ff'], ['#22c55e', '#0ea5e9'],
  ['#f43f5e', '#f59e0b'], ['#8b5cf6', '#ec4899'], ['#06b6d4', '#3b82f6'],
  ['#f97316', '#eab308'], ['#14b8a6', '#84cc16'],
];
function avatarFor(name, seed = name) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const [a, b] = GRADIENTS[h % GRADIENTS.length];
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
      </linearGradient></defs>
      <rect width="160" height="160" fill="url(#g)"/>
      <text x="80" y="104" font-family="Segoe UI,Roboto,sans-serif" font-size="72"
        font-weight="700" fill="rgba(255,255,255,.92)" text-anchor="middle">${initial}</text>
    </svg>`);
}

// ── seed cast ──────────────────────────────────────────────────────────────
const PEOPLE = [
  ['mkmalik', 'MK Malik', 42, 1], ['aylin', 'Aylin ✨', 31, 0], ['rafi', 'Rafi Ahmed', 27, 0],
  ['sofia', 'Sofia Rose', 24, 0], ['kenji', 'Kenji', 22, 0], ['mira', 'Mira Khan', 19, 0],
  ['dani', 'Dani_777', 17, 0], ['luna', 'Luna 🎤', 15, 0], ['argon', 'Argon', 13, 0],
  ['priya', 'Priya S.', 12, 0], ['tariq', 'Tariq', 10, 0], ['hana', 'Hana Bloom', 9, 0],
  ['zayn', 'Zayn', 8, 0], ['elif', 'Elif', 7, 0], ['noah', 'Noah W.', 6, 0],
  ['asha', 'Asha Rani', 5, 0], ['ilyas', 'Ilyas', 4, 0], ['nora', 'Nora', 3, 0],
  ['bilal', 'Bilal', 2, 0], ['chen', 'Chen Yu', 1, 0],
];

const ROOM_SEED = [
  ['Share a happy thing😊', 'party', 'Tell us one good thing about today', 'gold', ['newbie', 'friendly']],
  ['Welcome to our party🎉', 'party', 'Chill vibes only, grab a seat', 'rose', ['party', 'chill']],
  ['I like singing a lot.', 'sing', 'Karaoke night — request a song', 'violet', ['music', 'karaoke']],
  ['Enjoy the party!!!', 'party', 'Non-stop music & games', 'sunset', ['games', 'music']],
  ['Midnight Music Room 🌙', 'music', 'Slow songs and deep talks', 'night', ['lofi', 'calm']],
  ['Study with me 📚', 'study', 'Pomodoro 25/5 — mute & focus', 'mint', ['focus', 'silent']],
  ['Squad up — ranked lobby', 'gaming', 'Duo queue, call your role', 'ocean', ['valorant', 'fps']],
  ['Birthday Bash 🎂', 'birthday', 'Celebrating Mira today!', 'gold', ['cake', 'surprise']],
  ['Stand-up & jokes 😂', 'comedy', 'Open mic comedy hour', 'sunset', ['funny', 'openmic']],
  ['Dance floor 💃', 'dance', 'Drop your favourite track', 'rose', ['edm', 'bolly']],
  ['Late Night Talk ☕', 'chat', 'Random talks, zero judgement', 'violet', ['talk', 'late']],
  ['Morning Broadcast 📻', 'broadcast', 'Daily news and shoutouts', 'ocean', ['news', 'daily']],
  ['Adda time — Bangla 🇧🇩', 'chat', 'Bengali adda, sobe asho', 'mint', ['bangla', 'adda']],
  ['Chill out zone 🫧', 'party', 'Music, mics open for all', 'night', ['openmic', 'music']],
];

const GIFT_SEED = [
  ['rose', 'Rose', '🌹', 10], ['heart', 'Heart', '❤️', 20], ['kiss', 'Kiss', '💋', 50],
  ['lollipop', 'Lollipop', '🍭', 88], ['coffee', 'Coffee', '☕', 120], ['beer', 'Cheers', '🍺', 180],
  ['cake', 'Birthday Cake', '🎂', 299], ['teddy', 'Teddy', '🧸', 520], ['rocket', 'Rocket', '🚀', 888],
  ['crown', 'Golden Crown', '👑', 1888], ['castle', 'Dream Castle', '🏰', 3888],
  ['sports', 'Super Car', '🏎️', 8888], ['galaxy', 'Galaxy', '🌌', 18888],
  ['dragon', 'Dragon', '🐉', 32888],
];

const CHAT_LINES = [
  'Kemon acho sobai? 😄', 'Welcome everyone 🎧', 'Play something romantic 🎵',
  'Mic ta open kore dao please 🙏', 'Adaab from Dhaka ✨', 'Follow me, I follow back 💫',
  'Who is singing next?', 'Send a gift to the host 🎁', 'Anyone from Kolkata?',
  'This song is 🔥', 'Good night all, love you 💙', 'Beautiful voice! 👏',
];

const MOMENT_TEXTS = [
  'First time hosting a full room — 10 mics taken in 4 minutes 🥳',
  'Late night room was something else last night. Thank you all 💙',
  '3000 coins of roses in one song — you people are unreal 🌹',
  'Study room is at 24 people and completely silent 😂 perfect',
  'Chai + rainy evening + slow songs = perfect room ☕🌧️',
  'Just crossed level 30! Celebrating in my room tonight 🎂',
];

const ago = (min) => now() - min * 60_000;

// ── seed builder ───────────────────────────────────────────────────────────
function buildSeed() {
  const users = PEOPLE.map(([username, displayName, level, vip], i) => ({
    id: 'u_' + username,
    username,
    displayName,
    avatar: avatarFor(displayName, username),
    bio: `Hi, I'm ${displayName}. Talk to me in my room! 🎙️`,
    level,
    vip: !!vip,
    role: level >= 15 ? 'host' : 'user',
    isBot: true,
    coins: 2000 + i * 350,
    diamonds: i * 90,
    country: '',
    gender: 'any',
    followers: 40 + ((i * 37) % 260),
    following: 30 + ((i * 23) % 190),
    friends: 5 + ((i * 11) % 40),
    moments: 0,
    createdAt: ago(60 * 24 * (20 - i)),
  }));

  const byUsername = Object.fromEntries(users.map((u) => [u.username, u]));

  const gifts = GIFT_SEED.map(([id, name, emoji, price], i) => ({ id, name, emoji, price, anim: 'float', sort: i }));

  const rooms = ROOM_SEED.map(([title, category, topic, theme, tags], ri) => {
    const host = users[(ri + 1) % users.length];
    const guests = users.filter((u) => u.id !== host.id).sort(() => Math.random() - 0.5);

    const seats = new Array(10).fill(null);
    const members = [];
    const joined = {};

    const addMember = (user, seat) => {
      const at = ago(30 + Math.random() * 20);
      joined[user.id] = at;
      const m = { userId: user.id, seat, isMuted: true, isLocked: false, handUp: false, speaking: false, joinedAt: at, user };
      members.push(m);
      if (seat !== null) seats[seat] = m;
      return m;
    };

    addMember(host, 0);
    const speakers = 1 + Math.floor(Math.random() * 4);
    for (let i = 1; i <= speakers; i++) addMember(guests[i], i);
    const listeners = Math.floor(Math.random() * 12);
    for (let i = 0; i < listeners; i++) addMember(guests[speakers + 1 + i], null);

    return {
      id: 'r_' + ri,
      ownerId: host.id,
      title, topic, category, theme, tags,
      cover: '',
      language: category === 'chat' ? 'bangla' : 'any',
      locked: false,
      isPrivate: false,
      pinRequired: false,
      createdAt: ago(5 + ri * 7),
      giftCoins: ri * 850,
      seatCount: 10,
      seats,
      members,
      messages: Array.from({ length: 5 }, (_, i) => {
        const u = pick(users);
        return { id: uid(), kind: 'text', body: pick(CHAT_LINES), userId: u.id, user: u, meta: {}, createdAt: ago(60 - i * 7) };
      }),
    };
  });

  const moments = users.slice(0, 14).map((u, i) => ({
    id: 'm_' + i,
    userId: u.id,
    user: u,
    body: MOMENT_TEXTS[i % MOMENT_TEXTS.length],
    media: null,
    likes: Math.floor(Math.random() * 240),
    comments: [],
    liked: false,
    createdAt: ago(12 + i * 47),
  }));

  return {
    users,
    gifts,
    rooms,
    moments,
    follows: [],
    notifications: [],
    conversations: {},
    wallet: { coins: 5000, diamonds: 0 },
    meId: null,
  };
}

// ── persistence + cross-tab sync ───────────────────────────────────────────
let db = null;

function load() {
  if (db) return db;
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) { db = JSON.parse(raw); return db; }
  } catch (_) {}
  db = buildSeed();
  save();
  return db;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (_) { /* quota */ }
  }, 200);
}

const channel = (() => {
  try { return new BroadcastChannel(CHANNEL); } catch (_) { return null; }
})();

/** Re-read state written by another tab. */
function refreshFromStorage() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) db = JSON.parse(raw);
  } catch (_) {}
}

function announce(kind, payload) {
  try { channel?.postMessage({ kind, payload, tab: TAB_ID }); } catch (_) {}
  save();
}

const TAB_ID = uid();

// ── identity ───────────────────────────────────────────────────────────────
function me() {
  const d = load();
  if (!d.meId || !d.users.some((u) => u.id === d.meId)) {
    // Prefer the showcase account, but let a second tab become someone else so
    // two tabs behave like two people in the same room.
    let id = null;
    try { id = sessionStorage.getItem(SESSION_KEY); } catch (_) {}
    if (!id || !d.users.some((u) => u.id === id)) {
      const taken = new Set(peerTabs().map((t) => t.uid).filter(Boolean));
      const candidates = d.users.filter((u) => !taken.has(u.id));
      id = (candidates[0] || d.users[0]).id;
      try { sessionStorage.setItem(SESSION_KEY, id); } catch (_) {}
    }
    d.meId = id;
    announce('identity', { uid: id });
    save();
  }
  return d.users.find((u) => u.id === d.meId);
}

let tabRegistry = [];
function peerTabs() { return tabRegistry.filter((t) => t.tab !== TAB_ID && Date.now() - t.at < 15000); }

channel?.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg.tab === TAB_ID) return;
  if (msg.kind === 'hello') {
    tabRegistry.push({ tab: msg.tab, uid: msg.payload?.uid, at: Date.now() });
    // answer so the newcomer learns about us
    if (tabRegistry.length < 6) announce('identity', { uid: load().meId });
  } else if (msg.kind === 'identity') {
    tabRegistry.push({ tab: msg.tab, uid: msg.payload?.uid, at: Date.now() });
  } else {
    // any other message means shared state probably changed
    refreshFromStorage();
    bus.emit('external', msg);
  }
});

announce('hello', {});

// ── event bus for the local socket ─────────────────────────────────────────
function makeBus() {
  const map = new Map();
  return {
    on(evt, fn) { (map.get(evt) || map.set(evt, []).get(evt)).push(fn); },
    off(evt, fn) { const a = map.get(evt); if (a) map.set(evt, a.filter((f) => f !== fn)); },
    emit(evt, ...args) { (map.get(evt) || []).forEach((f) => { try { f(...args); } catch (e) { console.warn(e); } }); },
    count(evt) { return (map.get(evt) || []).length; },
  };
}
const bus = makeBus();

// ── projection helpers (mirror server/state.js) ────────────────────────────
const publicUser = (u) => u ? {
  id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar,
  level: u.level, vip: !!u.vip, role: u.role, bio: u.bio || '', isBot: !!u.isBot,
} : null;

function roomCard(room) {
  const occupied = room.seats.filter(Boolean).length;
  const listeners = room.members.filter((m) => m.seat === null).length;
  const host = room.members.find((m) => m.userId === room.ownerId)?.user
    || load().users.find((u) => u.id === room.ownerId);
  const recentUsers = room.members
    .slice()
    .sort((a, b) => (b.seat !== null) - (a.seat !== null) || b.joinedAt - a.joinedAt)
    .slice(0, 4)
    .map((m) => publicUser(m.user));

  return {
    id: room.id, title: room.title, topic: room.topic, category: room.category,
    cover: coverFor(room), theme: room.theme, tags: room.tags,
    locked: room.locked, isPrivate: room.isPrivate, language: room.language,
    host: publicUser(host), recentUsers,
    seatsTotal: 10, seatsTaken: occupied, seatsFree: 10 - occupied,
    listeners, online: room.members.length, hot: room.members.length,
    createdAt: room.createdAt, giftCoins: room.giftCoins,
    pinned: room.theme === 'gold' && occupied >= 3,
  };
}

function roomSnapshot(room) {
  const mine = room.members.find((m) => m.userId === me().id) || null;
  return {
    id: room.id, ownerId: room.ownerId, title: room.title, topic: room.topic,
    category: room.category, cover: coverFor(room), language: room.language,
    locked: room.locked, isPrivate: room.isPrivate, theme: room.theme,
    tags: room.tags, createdAt: room.createdAt, pinRequired: false, seatCount: 10,
    seats: room.seats.map((m) => (m ? {
      userId: m.userId, seat: m.seat, isMuted: m.isMuted, isLocked: m.isLocked,
      handUp: m.handUp, speaking: m.speaking, joinedAt: m.joinedAt, user: publicUser(m.user),
    } : null)),
    speakers: room.seats.filter(Boolean).length,
    listeners: room.members.filter((m) => m.seat === null).length,
    members: room.members.map((m) => ({
      userId: m.userId, seat: m.seat, isMuted: m.isMuted, isLocked: m.isLocked,
      handUp: m.handUp, speaking: m.speaking, joinedAt: m.joinedAt, user: publicUser(m.user),
    })),
    messages: room.messages.slice(-60),
    giftCoins: room.giftCoins,
    viewer: mine ? { userId: mine.userId, seat: mine.seat, isMuted: mine.isMuted, isLocked: mine.isLocked, handUp: mine.handUp, speaking: mine.speaking, joinedAt: mine.joinedAt, user: publicUser(mine.user) } : null,
    isOwner: mine ? room.ownerId === mine.userId : false,
  };
}

function findRoom(id) { return load().rooms.find((r) => r.id === id); }

// ── local API ──────────────────────────────────────────────────────────────
export const localApi = {
  async health() {
    return { ok: true, env: 'local', live: { rooms: load().rooms.length, users: load().users.length }, local: true };
  },

  async me() {
    const u = me();
    return { user: { ...publicUser(u), followers: u.followers, following: u.following, friends: u.friends, moments: u.moments || 0 }, wallet: { ...load().wallet } };
  },

  async demo() {
    const u = me();
    return { token: 'local', user: { ...publicUser(u), followers: u.followers, following: u.following, friends: u.friends, moments: u.moments || 0 } };
  },

  async rooms(params = {}) {
    const d = load();
    let cards = d.rooms.map(roomCard);

    if (params.category && !['all', 'related'].includes(params.category)) {
      cards = cards.filter((c) => c.category === params.category);
    }
    if (params.q) {
      const q = String(params.q).toLowerCase();
      cards = cards.filter((c) =>
        c.title.toLowerCase().includes(q) || (c.topic || '').toLowerCase().includes(q) ||
        (c.host?.displayName || '').toLowerCase().includes(q) ||
        (c.tags || []).some((t) => t.toLowerCase().includes(q)));
    }
    cards.sort((a, b) => {
      if (params.sort === 'new') return b.createdAt - a.createdAt;
      if (params.sort === 'seats') return b.seatsFree - a.seatsFree;
      return (b.online * 3 + b.seatsTaken * 2 + b.giftCoins / 500) - (a.online * 3 + a.seatsTaken * 2 + a.giftCoins / 500);
    });

    return { rooms: cards, categories: CATEGORIES.filter((c) => c.id !== 'all').map((c) => c.id), stats: { rooms: d.rooms.length, users: d.rooms.reduce((s, r) => s + r.members.length, 0) } };
  },

  async room(id) {
    const r = findRoom(id);
    if (!r) throw new Error('Room not found');
    return { room: roomSnapshot(r) };
  },

  async createRoom(body = {}) {
    const d = load();
    const room = {
      id: 'r_' + uid(),
      ownerId: me().id,
      title: body.title || `${me().displayName}'s room 🎙️`,
      topic: body.topic || '',
      category: body.category || 'party',
      theme: pick(['gold', 'rose', 'ocean', 'violet', 'mint', 'sunset', 'night']),
      tags: body.tags || [],
      cover: '', language: 'any',
      locked: !!body.locked, isPrivate: !!body.isPrivate, pinRequired: false,
      createdAt: now(), giftCoins: 0, seatCount: 10,
      seats: new Array(10).fill(null),
      members: [],
      messages: [],
    };
    d.rooms.unshift(room);
    announce('rooms');
    return { room: roomCard(room), pin: null };
  },

  async search(q) {
    const needle = String(q || '').toLowerCase();
    if (!needle) return { users: [], rooms: [] };
    const d = load();
    return {
      users: d.users.filter((u) => u.displayName.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle)).slice(0, 20).map(publicUser),
      rooms: d.rooms.map(roomCard).filter((c) => c.title.toLowerCase().includes(needle)).slice(0, 20),
    };
  },

  async user(id) {
    const u = load().users.find((x) => x.id === id);
    if (!u) throw new Error('User not found');
    return { user: { ...publicUser(u), followers: u.followers, following: u.following, friends: u.friends, moments: 0, isFollowing: load().follows.includes(id) } };
  },

  async follow(id) {
    const d = load();
    const i = d.follows.indexOf(id);
    if (i >= 0) d.follows.splice(i, 1); else d.follows.push(id);
    save();
    return { following: i < 0 };
  },

  async userGifts(id) {
    return { gifts: [], total: 0 };
  },

  async gifts() { return { gifts: load().gifts }; },

  async topup() { throw new Error('Top-ups are disabled in local mode'); },

  async moments() {
    const d = load();
    return { moments: d.moments.map((m) => ({ ...m, user: publicUser(m.user), comments: m.comments.length })) };
  },

  async postMoment(formData) {
    const d = load();
    const body = formData?.get?.('body') || '';
    const file = formData?.get?.('image');
    let media = null;
    if (file && file.size) media = await readAsDataURL(file);
    d.moments.unshift({ id: 'm_' + uid(), userId: me().id, user: me(), body, media, likes: 0, comments: [], liked: false, createdAt: now() });
    announce('moments');
    return { ok: true };
  },

  async likeMoment(id) {
    const m = load().moments.find((x) => x.id === id);
    if (!m) throw new Error('Post not found');
    m.liked = !m.liked;
    m.likes = Math.max(0, m.likes + (m.liked ? 1 : -1));
    save();
    return { liked: m.liked, likes: m.likes };
  },

  async momentComments(id) {
    const m = load().moments.find((x) => x.id === id);
    return { comments: (m?.comments || []).map((c) => ({ ...c, user: publicUser(c.user) })) };
  },

  async addComment(id, body) {
    const m = load().moments.find((x) => x.id === id);
    if (!m) throw new Error('Post not found');
    m.comments.push({ id: uid(), body, user: me(), createdAt: now() });
    save();
    return { ok: true };
  },

  async conversations() {
    const d = load();
    const list = Object.entries(d.conversations).map(([otherId, conv]) => ({
      id: otherId,
      other: publicUser(d.users.find((u) => u.id === otherId)),
      lastBody: conv.messages.at(-1)?.body || 'Say hello 👋',
      lastAt: conv.messages.at(-1)?.createdAt || 0,
      unread: conv.unread || 0,
    })).filter((c) => c.other).sort((a, b) => b.lastAt - a.lastAt);
    return { conversations: list };
  },

  async thread(userId) {
    const d = load();
    const conv = d.conversations[userId];
    if (conv) conv.unread = 0;
    save();
    return { messages: (conv?.messages || []).map((m) => ({ ...m, fromId: m.fromId })) };
  },

  async sendDM(userId, body) {
    const d = load();
    const conv = (d.conversations[userId] ||= { messages: [], unread: 0 });
    const msg = { id: uid(), fromId: me().id, toId: userId, body, createdAt: now() };
    conv.messages.push(msg);
    announce('dm', { userId, body });
    return { message: msg };
  },

  async updateMe(patch) {
    const d = load();
    const u = me();
    if (patch.displayName) u.displayName = patch.displayName;
    if (patch.bio !== undefined) u.bio = patch.bio;
    save();
    return { user: { ...publicUser(u), followers: u.followers, following: u.following, friends: u.friends, moments: 0 } };
  },

  async uploadAvatar(file) {
    const u = me();
    u.avatar = await readAsDataURL(file);
    announce('avatar', { avatar: u.avatar });
    return { user: { ...publicUser(u), followers: u.followers, following: u.following, friends: u.friends, moments: 0 } };
  },

  async dailyBonus() {
    const d = load();
    const KEY = 'mkmalik.local.bonus';
    const last = Number(localStorage.getItem(KEY) || 0);
    const DAY = 86_400_000;
    if (now() - last < DAY) {
      const left = Math.ceil((DAY - (now() - last)) / 3_600_000);
      throw new Error(`Already claimed — come back in ~${left}h`);
    }
    localStorage.setItem(KEY, String(now()));
    d.wallet.coins += 150;
    save();
    return { ok: true, coins: d.wallet.coins, awarded: 150 };
  },

  async notifications() {
    return { notifications: load().notifications.slice().reverse(), unread: 0 };
  },
  async readNotifications() { return { ok: true }; },

  async leaderboard(period = 'day') {
    const d = load();
    const hosts = d.users.slice().sort((a, b) => b.diamonds - a.diamonds).slice(0, 20)
      .map((u) => ({ ...publicUser(u), earned: u.diamonds * 3 }));
    const givers = d.users.slice().sort((a, b) => b.coins - a.coins).slice(0, 20)
      .map((u) => ({ ...publicUser(u), spent: Math.round(u.coins / 2) }));
    return { period, hosts, givers };
  },

  async iceServers() { return { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] }; },
};

function readAsDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// ── local socket ───────────────────────────────────────────────────────────
/**
 * Drop-in replacement for the Socket.IO client for the events the room screen
 * uses. Seats, chat and gifts behave exactly like the server's, so the same UI
 * code drives it.
 */
export class LocalSocket {
  constructor() {
    this.id = 'local-' + uid();
    this.connected = true;
    this.events = makeBus();
    this.roomId = null;

    // mirror changes another tab made
    bus.on('external', () => {
      if (this.roomId) this.pushState();
    });

    // let the UI settle before announcing we're up
    setTimeout(() => {
      this.events.emit('connect');
      const u = me();
      this.events.emit('ready', { user: publicUser(u), serverTime: now(), seats: 10 });
    }, 30);
  }

  on(evt, fn) { this.events.on(evt, fn); return this; }
  off(evt, fn) { this.events.off(evt, fn); return this; }
  disconnect() { this.connected = false; this.leaveRoom(); }

  /** Notify every listener in this room. Local mode has one client per tab. */
  toRoom(evt, payload) { this.events.emit(evt, payload); }

  pushState() {
    const room = findRoom(this.roomId);
    if (!room) return;
    this.events.emit('room:state', roomSnapshot(room));
  }

  pushPeers(room) {
    // nobody else has a browser, so there is no peer to negotiate with
    this.events.emit('room:peers', { roomId: room.id, peers: [] });
  }

  pushMessage(room, msg) {
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.splice(0, room.messages.length - 120);
    save();
    this.events.emit('room:message', msg);
  }

  system(room, body) {
    this.pushMessage(room, { id: uid(), kind: 'system', body, userId: null, user: null, meta: {}, createdAt: now() });
  }

  leaveRoom() {
    if (!this.roomId) return;
    const room = findRoom(this.roomId);
    if (room) {
      room.members = room.members.filter((m) => m.userId !== me().id);
      room.seats = room.seats.map((m) => (m && m.userId === me().id ? null : m));
      save();
    }
    this.roomId = null;
  }

  emit(evt, payload, ack) {
    if (typeof payload === 'function') { ack = payload; payload = {}; }
    payload = payload || {};
    const d = load();
    const myUser = me();
    const ok = (extra = {}) => ack?.({ ok: true, ...extra });
    const fail = (error) => ack?.({ ok: false, error });

    switch (evt) {
      case 'presence:ping': return ok({ t: now() });

      case 'room:join': {
        const room = findRoom(payload.roomId);
        if (!room) return fail('Room not found or closed');
        this.leaveRoom();
        this.roomId = room.id;

        let member = room.members.find((m) => m.userId === myUser.id);
        if (!member) {
          member = { userId: myUser.id, seat: null, isMuted: true, isLocked: false, handUp: false, speaking: false, joinedAt: now(), user: myUser };
          room.members.push(member);
          this.system(room, `${myUser.displayName} joined the room`);
        }
        // "seat: true" means take the first free seat, like the server
        if (payload.seat === true && member.seat === null) {
          const free = room.seats.findIndex((s) => !s);
          if (free !== -1) { member.seat = free; room.seats[free] = member; member.isMuted = true; }
        }
        save();
        return ok({ room: roomSnapshot(room), peers: [] });
      }

      case 'room:leave': this.leaveRoom(); return ok();
      case 'room:snapshot': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Room closed');
        return ok({ room: roomSnapshot(room), peers: [] });
      }

      case 'seat:take': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Join a room first');
        const member = room.members.find((m) => m.userId === myUser.id);
        if (!member) return fail('Join the room first');
        if (member.seat !== null) return fail('You are already on a mic seat');
        const wanted = Number.isInteger(payload.index) ? payload.index : room.seats.findIndex((s) => !s);
        if (wanted < 0 || wanted > 9) return fail('All 10 mic seats are full — join as a listener');
        if (room.seats[wanted]) return fail('That seat is already taken');
        member.seat = wanted; member.isMuted = true; member.handUp = false;
        room.seats[wanted] = member;
        this.system(room, `${myUser.displayName} took mic seat ${wanted + 1}`);
        save();
        this.events.emit('room:seat', { userId: myUser.id, seat: wanted, member: { ...member, user: publicUser(myUser) } });
        this.pushState(); this.pushPeers(room);
        return ok({ seat: wanted, peers: [] });
      }

      case 'seat:leave': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Join a room first');
        const member = room.members.find((m) => m.userId === myUser.id);
        if (!member || member.seat === null) return fail('You are not on a mic seat');
        const freed = member.seat;
        room.seats[freed] = null;
        member.seat = null; member.isMuted = true;
        // promote the first raised hand, like the server does
        const next = room.members.filter((m) => m.seat === null && m.handUp).sort((a, b) => a.joinedAt - b.joinedAt)[0];
        if (next) { next.seat = freed; next.handUp = false; room.seats[freed] = next; this.system(room, `${next.user.displayName} was moved up to the mic`); }
        save();
        this.events.emit('room:seat', { userId: myUser.id, seat: null, member: { ...member, user: publicUser(myUser) } });
        this.pushState(); this.pushPeers(room);
        return ok({ promoted: next ? { ...next, user: publicUser(next.user) } : null });
      }

      case 'seat:mute': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Join a room first');
        const member = room.members.find((m) => m.userId === myUser.id);
        if (!member) return fail('Join the room first');
        if (member.seat === null) return fail('Only users on a mic seat can toggle the mic');
        member.isMuted = !!payload.muted;
        save();
        this.events.emit('room:seat', { userId: myUser.id, seat: member.seat, isMuted: member.isMuted, member: { ...member, user: publicUser(myUser) } });
        return ok({ muted: member.isMuted });
      }

      case 'seat:lock': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Join a room first');
        if (room.ownerId !== myUser.id) return fail('Only the host can lock seats');
        const seat = Number(payload.index);
        const occupant = room.seats[seat];
        if (occupant) { occupant.isLocked = !!payload.locked; save(); }
        this.events.emit('room:seatlock', { seat, locked: !!payload.locked, occupantId: occupant?.userId || null });
        this.pushState();
        return ok({ seat, locked: !!payload.locked });
      }

      case 'seat:kick': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Join a room first');
        if (room.ownerId !== myUser.id) return fail('Only the host can manage seats');
        const target = room.members.find((m) => m.userId === payload.userId);
        if (!target || target.seat === null) return fail('That user is not on a mic seat');
        room.seats[target.seat] = null;
        target.seat = null; target.isMuted = true;
        this.system(room, `${target.user.displayName} was removed from the mic`);
        save();
        this.events.emit('room:seat', { userId: target.userId, seat: null, member: { ...target, user: publicUser(target.user) }, kicked: true });
        this.pushState(); this.pushPeers(room);
        return ok();
      }

      case 'hand:raise': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Join a room first');
        const member = room.members.find((m) => m.userId === myUser.id);
        if (!member) return fail('Join the room first');
        member.handUp = payload.up !== false;
        save();
        this.events.emit('room:hand', { userId: myUser.id, up: member.handUp, member: { ...member, user: publicUser(myUser) } });
        if (member.handUp) this.system(room, `${myUser.displayName} raised a hand ✋`);
        return ok({ up: member.handUp });
      }

      case 'room:update': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Join a room first');
        if (room.ownerId !== myUser.id) return fail('Only the host can edit the room');
        if (payload.title !== undefined) room.title = payload.title;
        if (payload.topic !== undefined) room.topic = payload.topic;
        if (payload.locked !== undefined) room.locked = !!payload.locked;
        save();
        this.pushState();
        return ok({ room: roomSnapshot(room) });
      }

      case 'room:end': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Room not found');
        if (room.ownerId !== myUser.id) return fail('Only the host can end the room');
        const d = load();
        d.rooms = d.rooms.filter((r) => r.id !== room.id);
        this.roomId = null;
        announce('rooms');
        this.events.emit('room:closed', { reason: 'host_ended' });
        return ok();
      }

      case 'chat:send': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Join a room first');
        const body = String(payload.body || '').trim().slice(0, 500);
        if (!body) return fail('Empty message');
        const msg = { id: uid(), kind: 'text', body, userId: myUser.id, user: publicUser(myUser), meta: {}, createdAt: now() };
        this.pushMessage(room, msg);
        return ok({ message: msg });
      }

      case 'gift:send': {
        const room = findRoom(this.roomId);
        if (!room) return fail('Join a room first');
        const gift = d.gifts.find((g) => g.id === payload.giftId);
        if (!gift) return fail('Unknown gift');
        const qty = clamp(Number(payload.qty) || 1, 1, 99);
        const cost = gift.price * qty;
        const target = room.members.find((m) => m.userId === payload.toUserId);
        if (!target) return fail('That person is not in this room');
        if (d.wallet.coins < cost) return fail(`Not enough coins — you need ${cost - d.wallet.coins} more`);
        d.wallet.coins -= cost;
        d.wallet.diamonds += cost;
        room.giftCoins += cost;
        const event = {
          id: uid(), gift: { ...gift }, qty, coins: cost,
          from: publicUser(myUser), to: { ...target, user: publicUser(target.user) },
          createdAt: now(), roomId: room.id,
        };
        save();
        this.events.emit('room:gift', event);
        this.pushMessage(room, {
          id: uid(), kind: 'gift', userId: myUser.id, user: publicUser(myUser),
          body: `sent ${gift.emoji} ${gift.name} ×${qty} to ${target.user.displayName}`,
          meta: { giftId: gift.id, qty, coins: cost, to: target.userId }, createdAt: now(),
        });
        this.pushState();
        return ok({ coins: d.wallet.coins, event });
      }

      case 'rtc:signal':
      case 'rtc:speaking':
      case 'rtc:announce':
        return ok();   // nobody to negotiate with

      case 'dm:send': {
        const to = d.users.find((u) => u.id === payload.toUserId);
        if (!to) return fail('User not found');
        const body = String(payload.body || '').trim();
        if (!body) return fail('Empty message');
        const conv = (d.conversations[to.id] ||= { messages: [], unread: 0 });
        const msg = { id: uid(), fromId: myUser.id, toId: to.id, body, createdAt: now() };
        conv.messages.push(msg);
        announce('dm', { userId: to.id, body });
        return ok({ message: msg });
      }

      case 'dm:typing': return ok();

      default:
        return ok();
    }
  }
}

// ── simulation ─────────────────────────────────────────────────────────────
/**
 * Keeps the demo alive: people drift on and off mic seats and chat, so the
 * grid and rooms never look frozen.
 */
let simTimer = null;
export function startSimulation(socket) {
  if (simTimer) return;
  simTimer = setInterval(() => {
    const d = load();
    if (!d.rooms.length) return;

    const room = pick(d.rooms);
    const inRoom = socket?.roomId === room.id;
    const changed = { seat: false, chat: false };

    // someone takes or leaves a seat
    if (Math.random() < 0.45) {
      const free = room.seats.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0);
      const audioOnly = room.members.filter((m) => m.seat === null && m.userId !== socket?.roomId);
      if (free.length && Math.random() < 0.65) {
        const candidate = pick(room.members.filter((m) => m.seat === null && m.userId !== d.meId));
        if (candidate) {
          const seat = pick(free);
          candidate.seat = seat; candidate.isMuted = true;
          room.seats[seat] = candidate;
          changed.seat = true;
        }
      } else {
        const speaker = pick(room.members.filter((m) => m.seat !== null && m.userId !== room.ownerId && m.userId !== d.meId));
        if (speaker) { room.seats[speaker.seat] = null; speaker.seat = null; changed.seat = true; }
      }
    }

    // a little chatter
    if (Math.random() < 0.5) {
      const speaker = pick(room.members.filter((m) => m.seat !== null && m.userId !== d.meId));
      if (speaker) {
        const msg = { id: uid(), kind: 'text', body: pick(CHAT_LINES), userId: speaker.userId, user: publicUser(speaker.user), meta: {}, createdAt: now() };
        room.messages.push(msg);
        if (room.messages.length > 200) room.messages.splice(0, room.messages.length - 120);
        changed.chat = true;
        if (inRoom) socket.events.emit('room:message', msg);
      }
    }

    // randomly show someone "speaking"
    room.members.forEach((m) => { if (m.seat !== null && m.userId !== d.meId) m.speaking = Math.random() < 0.25; });

    save();
    if (inRoom) {
      socket.pushState();
      if (changed.seat) socket.pushPeers(room);
      room.members.forEach((m) => {
        if (m.seat !== null) socket.events.emit('room:speaking', { userId: m.userId, speaking: m.speaking });
      });
    }
  }, 7000);
}

export function resetLocal() {
  try { localStorage.removeItem(DB_KEY); localStorage.removeItem('mkmalik.local.bonus'); } catch (_) {}
  db = null;
}

export const db_ = () => load();
