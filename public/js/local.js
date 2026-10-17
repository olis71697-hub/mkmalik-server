/* ---------------------------------------------------------------------------
   Local fallback engine (demo mode).

   When the app is opened from a static host with no Panda Voice server
   behind it, this module keeps the UI usable: a demo account, simulated
   rooms with bots on the 10 seats, chat, reactions, gifts and DMs all run
   inside the browser. It implements the same surface the screens expect
   from `api` + `socket`, so nothing else changes.

   It is a simulation — real voice needs the Node server (see README).
   --------------------------------------------------------------------------- */

import { svgAvatar } from './util.js';

const LS = 'panda.local.v1';

/** mirror state between tabs so two open copies stay in sync */
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('panda-local') : null;

function load() {
  try { return JSON.parse(localStorage.getItem(LS)) || null; } catch (_) { return null; }
}
function save(s) {
  try {
    localStorage.setItem(LS, JSON.stringify(s));
    channel?.postMessage({ t: Date.now() });
  } catch (_) {}
}
if (channel) channel.onmessage = () => { S = load(); };

let S = null;
function ensure() {
  if (S) return S;
  S = load() || buildSeed();
  return S;
}

/** rooms the demo engine always starts with */
const ROOM_SEED = [
  ['🐼 Panda Adda — সবাই আসো', 'chat', 'বাংলা আড্ডা, ১০টা মাইক খোলা', 'bamboo', 5],
  ['Welcome to our party 🎉', 'party', 'Chill vibes only', 'gold', 4],
  ['আমি গান গাইতে ভালোবাসি 🎤', 'sing', 'Karaoke night', 'violet', 3],
  ['Study with me 📚', 'study', 'Pomodoro 25/5', 'mint', 2],
  ['Squad up — ranked lobby', 'gaming', 'Duo queue', 'ocean', 1],
];

/** First boot: build the demo world (me + bots + rooms + gifts). */
function buildSeed() {
  const now = Date.now();
  const mk = (id, name, level, vip) => ({
    id, username: id, displayName: name, avatar: svgAvatar(name, id), level, vip: !!vip,
    role: 'user', userCode: String(100000 + Math.floor(Math.random() * 899999)),
    bio: '', isBot: id !== 'me', coins: 2000, diamonds: 0,
    followers: Math.floor(Math.random() * 900), following: Math.floor(Math.random() * 200),
    isFollowing: false, online: id !== 'me', createdAt: now - 86400_000 * 30,
    giftsReceived: 0, giftsSent: 0, giftsReceivedCoins: 0, giftsSentCoins: 0, roomsHosted: 1,
    moments: 0, friends: 3, blocked: false, xp: 900, xpNext: 1280, xpFloor: 800,
    hasPassword: true,
  });
  const bots = [
    mk('b1', 'Nusrat ✨', 31, 1), mk('b2', 'Rafi Ahmed', 27, 0), mk('b3', 'Tuli Roy', 24, 1),
    mk('b4', 'Kenji', 22, 0), mk('b5', 'Mira Khan', 19, 0), mk('b6', 'Dani_777', 17, 0),
    mk('b7', 'Luna 🎤', 15, 0), mk('b8', 'Priya S.', 12, 0),
  ];
  const me = mk('me', 'আমি (ডেমো)', 8, 0);
  me.isBot = false; me.online = true; me.bio = 'ডেমো মোডে Panda Voice দেখছি 🐼';

  const giftList = [
    ['heart', 'Heart', '❤️', 10], ['rose', 'Rose', '🌹', 20], ['flower', 'Flower', '🌸', 50],
    ['star', 'Star', '⭐', 88], ['love', 'Love', '😍', 120], ['coffee', 'Coffee', '☕', 180],
    ['teddy', 'Teddy Bear', '🧸', 299], ['cake', 'Birthday Cake', '🎂', 520],
    ['lion', 'Lion', '🦁', 888], ['crown', 'Golden Crown', '👑', 1888],
    ['car', 'Super Car', '🏎️', 3888], ['dragon', 'Dragon', '🐉', 18888],
  ].map(([id, name, emoji, price], i) => ({ id, name, emoji, price, anim: 'float', sort: i + 1 }));

  const rooms = ROOM_SEED.map(([title, category, topic, theme, nSeats], i) => {
    const host = bots[i % bots.length];
    const seats = new Array(10).fill(null);
    for (let s = 0; s < nSeats; s++) seats[s] = bots[(i + s) % bots.length].id;
    return {
      id: 'r' + (i + 1), title, topic, category, theme, language: /[\u0980-\u09FF]/.test(title) ? 'bn' : 'any',
      host, seats, listeners: Math.floor(Math.random() * 20), locked: false, isPrivate: false,
      tags: [], createdAt: now - (i + 1) * 600_000, rules: 'সবার সাথে ভালো ব্যবহার করুন 🐼',
      giftCoins: i * 850, mods: [], chatOpen: true, pinRequired: false,
      messages: [
        { id: 'm' + i + 'a', kind: 'system', body: 'হোস্ট মাইক সিটগুলো খুলে দিল 🎙️', createdAt: now - 300_000 },
        { id: 'm' + i + 'b', kind: 'text', body: 'কেমন আছো সবাই? 😄', userId: host.id, user: host, createdAt: now - 120_000 },
      ],
    };
  });

  const st = {
    me, bots, users: [me, ...bots], rooms, gifts: giftList,
    wallet: { coins: 2000, diamonds: 120 },
    transactions: [{ id: 't1', delta: 1500, reason: 'welcome_bonus', createdAt: now - 3600_000 }],
    notifications: [
      { id: 'n1', kind: 'follow', title: 'নতুন ফলোয়ার', body: 'Nusrat ✨ এখন আপনাকে ফলো করছে', seen: false, createdAt: now - 600_000 },
    ],
    conversations: [
      { id: 'c1', other: bots[0], lastBody: 'রুমে আসবে? 🎤', lastAt: now - 400_000, unread: 1,
        messages: [
          { id: 'd1', fromId: bots[0].id, body: 'হাই! আজ রাতে রুম করবে? 🎤', createdAt: now - 500_000 },
          { id: 'd2', fromId: 'me', body: 'হ্যাঁ! ৯টায় খুলব 😄', createdAt: now - 480_000 },
          { id: 'd3', fromId: bots[0].id, body: 'রুমে আসবে? 🎤', createdAt: now - 400_000 },
        ] },
    ],
    settings: { language: 'bn', theme: 'dark', notify_follow: 1, notify_message: 1, notify_gift: 1, notify_invite: 1, dm_privacy: 'everyone', show_online: 1 },
    joined: null,
  };
  save(st);
  return st;
}

function pub(u) { return u; }
function findUser(id) { return ensure().users.find((u) => u.id === id) || null; }

// ── REST surface ───────────────────────────────────────────────────────────
export const localApi = {
  demo() {
    const s = ensure();
    return Promise.resolve({ token: 'local-demo', user: pub(s.me), demo: true });
  },
  otpRequest(phone) {
    return Promise.resolve({ ok: true, phone, exists: false, delivery: 'console', ttlSec: 300, devCode: '123456' });
  },
  otpVerify(_phone, _code) { return this.demo(); },
  forgot() { return Promise.resolve({ ok: true, ttlSec: 300, devCode: '123456' }); },
  reset() { return Promise.resolve({ ok: true }); },

  me() {
    const s = ensure();
    return Promise.resolve({ user: pub(s.me), wallet: s.wallet, settings: s.settings });
  },
  updateMe(p = {}) {
    const s = ensure();
    if (p.displayName) s.me.displayName = p.displayName;
    if (p.bio !== undefined) s.me.bio = p.bio;
    if (p.gender) s.me.gender = p.gender;
    if (p.country !== undefined) s.me.country = p.country;
    save(s);
    return Promise.resolve({ user: pub(s.me) });
  },
  uploadAvatar() { return Promise.resolve({ user: pub(ensure().me) }); },
  dailyBonus() {
    const s = ensure();
    s.wallet.coins += 150;
    s.transactions.unshift({ id: 'tb' + Date.now(), delta: 150, reason: 'daily_bonus', createdAt: Date.now() });
    save(s);
    return Promise.resolve({ ok: true, coins: s.wallet.coins, awarded: 150 });
  },
  changePassword() { return Promise.resolve({ ok: true }); },
  deleteAccount() { localStorage.removeItem(LS); S = null; return Promise.resolve({ ok: true, deleted: true }); },

  settings() { return Promise.resolve({ settings: ensure().settings }); },
  saveSettings(p = {}) {
    const s = ensure();
    s.settings = { ...s.settings, ...p };
    save(s);
    return Promise.resolve({ settings: s.settings });
  },

  blocks() { return Promise.resolve({ blocked: [] }); },
  block(id) {
    const s = ensure();
    const u = findUser(id);
    if (u) { u.blocked = true; save(s); }
    return Promise.resolve({ blocked: true });
  },
  unblock(id) {
    const s = ensure();
    const u = findUser(id);
    if (u) { u.blocked = false; save(s); }
    return Promise.resolve({ blocked: false });
  },
  report() { return Promise.resolve({ ok: true, reportId: 'local' }); },

  rooms(params = {}) {
    const s = ensure();
    let cards = s.rooms.map((r) => ({
      id: r.id, title: r.title, topic: r.topic, category: r.category, theme: r.theme,
      tags: r.tags, locked: r.locked, isPrivate: r.isPrivate, language: r.language,
      host: pub(r.host), recentUsers: [], seatsTotal: 10, seatsTaken: r.seats.filter(Boolean).length,
      seatsFree: 10 - r.seats.filter(Boolean).length, listeners: r.listeners,
      online: r.seats.filter(Boolean).length + r.listeners, hot: r.listeners, createdAt: r.createdAt,
      giftCoins: r.giftCoins, pinned: false,
    }));
    if (params.category && params.category !== 'all') cards = cards.filter((c) => c.category === params.category);
    if (params.q) cards = cards.filter((c) => c.title.includes(params.q));
    if (params.sort === 'new') cards.sort((a, b) => b.createdAt - a.createdAt);
    else cards.sort((a, b) => b.online - a.online);
    return Promise.resolve({
      rooms: cards,
      categories: ['broadcast', 'party', 'sing', 'birthday', 'music', 'gaming', 'chat', 'study', 'dance', 'comedy'],
      stats: { rooms: s.rooms.length, users: 40, speakers: 25, seats: s.rooms.length * 10 },
    });
  },
  room(id) {
    const s = ensure();
    const r = s.rooms.find((x) => x.id === id);
    if (!r) return Promise.reject(new Error('Room not found'));
    return Promise.resolve({ room: roomSnapshot(r) });
  },
  createRoom(body = {}) {
    const s = ensure();
    const r = {
      id: 'r' + Date.now(), title: body.title || 'আমার রুম', topic: body.topic || '', category: body.category || 'party',
      theme: body.theme || 'bamboo', language: body.language || 'any', host: s.me, seats: new Array(10).fill(null),
      listeners: 0, locked: false, isPrivate: false, tags: [], createdAt: Date.now(), rules: body.rules || '',
      giftCoins: 0, mods: [], chatOpen: true, pinRequired: false, messages: [],
    };
    s.rooms.unshift(r);
    save(s);
    return Promise.resolve({ room: cardOf(r), pin: null });
  },

  search(q) {
    const s = ensure();
    return Promise.resolve({
      users: s.users.filter((u) => u.displayName.includes(q) || u.username.includes(q)).map(pub),
      rooms: s.rooms.filter((r) => r.title.includes(q)).map(cardOf),
    });
  },
  users(sort = 'popular') {
    const s = ensure();
    return Promise.resolve({ users: s.users.filter((u) => u.id !== 'me').map(pub), sort });
  },
  user(id) {
    const u = findUser(id);
    return u ? Promise.resolve({ user: pub(u) }) : Promise.reject(new Error('User not found'));
  },
  follow(id) {
    const s = ensure();
    const u = findUser(id);
    if (u) { u.isFollowing = !u.isFollowing; u.followers += u.isFollowing ? 1 : -1; save(s); }
    return Promise.resolve({ following: !!u?.isFollowing });
  },
  followers(id) { return Promise.resolve({ users: ensure().users.filter((u) => u.id !== id).slice(0, 5).map(pub) }); },
  following(id) { return Promise.resolve({ users: ensure().users.filter((u) => u.id !== id).slice(0, 5).map(pub) }); },
  userGifts() { return Promise.resolve({ gifts: [], total: 0 }); },

  gifts() { return Promise.resolve({ gifts: ensure().gifts }); },
  topup() { return Promise.resolve({ ok: true, coins: ensure().wallet.coins }); },

  wallet() {
    const s = ensure();
    return Promise.resolve({ wallet: s.wallet, transactions: s.transactions });
  },
  packages() {
    return Promise.resolve({
      packages: [
        { id: 'p100', coins: 100, price: 20, label: ' starter', bonus: 0, currency: 'BDT' },
        { id: 'p520', coins: 520, price: 99, label: ' popular', bonus: 20, currency: 'BDT' },
        { id: 'p1200', coins: 1200, price: 199, label: ' value', bonus: 100, currency: 'BDT' },
        { id: 'p3300', coins: 3300, price: 499, label: ' pro', bonus: 300, currency: 'BDT' },
      ],
      mode: 'mock',
      methods: [
        { id: 'bkash', label: 'bKash', emoji: '📱' },
        { id: 'nagad', label: 'Nagad', emoji: '💸' },
        { id: 'card', label: 'Card', emoji: '💳' },
      ],
    });
  },
  purchase(packageId, paymentMethod) {
    const s = ensure();
    const pkg = this.packages().packages.find((p) => p.id === packageId);
    if (!pkg) return Promise.reject(new Error('Unknown package'));
    if (!/^MOCK-/.test(s._lastRef || 'MOCK-x')) return Promise.reject(new Error('bad ref'));
    s.wallet.coins += pkg.coins + pkg.bonus;
    s.transactions.unshift({ id: 'tp' + Date.now(), delta: pkg.coins + pkg.bonus, reason: 'purchase', createdAt: Date.now() });
    save(s);
    return Promise.resolve({ ok: true, status: 'success', credited: pkg.coins + pkg.bonus, coins: s.wallet.coins, gateway: 'mock' });
  },

  moments() { return Promise.resolve({ moments: [] }); },
  conversations() { return Promise.resolve({ conversations: ensure().conversations }); },
  thread(userId) {
    const s = ensure();
    const c = s.conversations.find((x) => x.other.id === userId);
    return Promise.resolve({ messages: (c?.messages || []).map((m) => ({ ...m, id: m.id, convId: c.id })) });
  },
  sendDM(userId, body) {
    const s = ensure();
    let c = s.conversations.find((x) => x.other.id === userId);
    const other = findUser(userId);
    if (!c && other) {
      c = { id: 'c' + Date.now(), other, lastBody: '', lastAt: 0, unread: 0, messages: [] };
      s.conversations.unshift(c);
    }
    if (!c) return Promise.reject(new Error('User not found'));
    const msg = { id: 'dm' + Date.now(), fromId: 'me', body, createdAt: Date.now() };
    c.messages.push(msg);
    c.lastBody = body; c.lastAt = msg.createdAt;
    // the bot replies
    setTimeout(() => {
      c.messages.push({ id: 'dm' + Date.now(), fromId: userId, body: 'হুম, ঠিক আছে! 🐼', createdAt: Date.now() });
      c.lastBody = 'হুম, ঠিক আছে! 🐼'; c.lastAt = Date.now();
      save(s);
      window.dispatchEvent(new CustomEvent('panda-local-dm', { detail: { userId, body: 'হুম, ঠিক আছে! 🐼' } }));
    }, 1400);
    save(s);
    return Promise.resolve({ message: { ...msg, user: s.me } });
  },

  notifications() {
    const s = ensure();
    return Promise.resolve({ notifications: s.notifications, unread: s.notifications.filter((n) => !n.seen).length });
  },
  readNotifications() {
    const s = ensure();
    s.notifications.forEach((n) => { n.seen = true; });
    save(s);
    return Promise.resolve({ ok: true });
  },
  leaderboard(period = 'day') {
    const s = ensure();
    const list = s.users.filter((u) => u.id !== 'me')
      .sort((a, b) => b.followers - a.followers)
      .map((u, i) => ({ ...u, earned: (20 - i) * 120, spent: (18 - i) * 90, received: (20 - i) * 120, gifts: 20 - i }));
    return Promise.resolve({ period, hosts: list, givers: list, receivers: list });
  },
  health() {
    return Promise.resolve({ ok: true, app: 'Panda Voice (local)', live: { rooms: ensure().rooms.length, users: 9, speakers: 9, seats: 90 }, demoAutoLogin: true });
  },
  iceServers() { return Promise.resolve({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); },
};

function cardOf(r) {
  return {
    id: r.id, title: r.title, topic: r.topic, category: r.category, theme: r.theme,
    host: pub(r.host), seatsTotal: 10, seatsTaken: r.seats.filter(Boolean).length,
    seatsFree: 10 - r.seats.filter(Boolean).length, listeners: r.listeners, online: r.listeners + r.seats.filter(Boolean).length,
    hot: r.listeners, createdAt: r.createdAt, giftCoins: r.giftCoins, language: r.language,
    locked: r.locked, isPrivate: r.isPrivate, tags: r.tags, recentUsers: [], pinned: false,
  };
}

function roomSnapshot(r) {
  const s = ensure();
  const members = [r.host, ...r.seats.filter(Boolean).map((id) => findUser(id)).filter(Boolean)]
    .map((u, i) => ({
      userId: u.id, seat: i === 0 ? 0 : r.seats.indexOf(u.id), isMuted: false, isLocked: false,
      handUp: false, speaking: false, joinedAt: r.createdAt, user: pub(u),
    }));
  return {
    id: r.id, ownerId: r.host.id, title: r.title, topic: r.topic, category: r.category,
    language: r.language, locked: r.locked, isPrivate: r.isPrivate, theme: r.theme, tags: r.tags,
    createdAt: r.createdAt, pinRequired: false, rules: r.rules, chatOpen: r.chatOpen, mods: r.mods,
    seatCount: 10,
    seats: r.seats.map((id) => {
      if (!id) return null;
      const u = findUser(id);
      return u ? members.find((m) => m.userId === id) : null;
    }),
    speakers: r.seats.filter(Boolean).length, listeners: r.listeners,
    members, messages: r.messages, giftCoins: r.giftCoins,
    viewer: s.joined === r.id ? members.find((m) => m.userId === 'me') : null,
    isOwner: false, isMod: false,
  };
}

// ── Socket.IO-shaped local transport ───────────────────────────────────────
export class LocalSocket {
  constructor() {
    this.id = 'local-' + Math.random().toString(36).slice(2, 8);
    this.connected = true;
    this.handlers = new Map();
    this.acks = new Map();
    this._seq = 0;
    this.user = { id: 'me' };
    this.data = { roomId: null, seat: null };
    // bots talk sometimes so the room feels alive
    setInterval(() => this._ambient(), 12000);
  }
  on(evt, fn) { (this.handlers.get(evt) || this.handlers.set(evt, []).get(evt)).push(fn); return this; }
  off(evt) { this.handlers.delete(evt); }
  emit(evt, payload, ack) {
    const run = (result) => { if (typeof ack === 'function') setTimeout(() => ack({ ok: true, ...result }), 60); };
    const fire = (name, data) => { (this.handlers.get(name) || []).forEach((f) => f(data)); };
    const s = ensure();

    switch (evt) {
      case 'room:join': {
        const r = s.rooms.find((x) => x.id === payload?.roomId);
        if (!r) return ack?.({ ok: false, error: 'Room not found' });
        s.joined = r.id;
        this.data.roomId = r.id;
        run({ room: roomSnapshot(r), peers: [] });
        fire('room:state', roomSnapshot(r));
        break;
      }
      case 'room:leave': {
        const r = s.rooms.find((x) => x.id === this.data.roomId);
        if (r && r.seats.includes('me')) r.seats[r.seats.indexOf('me')] = null;
        s.joined = null;
        this.data.roomId = null;
        run({});
        break;
      }
      case 'room:snapshot': {
        const r = s.rooms.find((x) => x.id === (payload?.roomId || this.data.roomId));
        run({ room: r ? roomSnapshot(r) : null });
        break;
      }
      case 'seat:take': {
        const r = s.rooms.find((x) => x.id === this.data.roomId);
        if (!r) return ack?.({ ok: false, error: 'Join a room first' });
        let idx = payload?.index;
        if (idx === undefined || idx === null) idx = r.seats.findIndex((s) => !s);
        if (idx < 0 || idx > 9 || r.seats[idx]) return ack?.({ ok: false, error: idx === -1 || !r.seats[idx] ? 'All 10 mic seats are full — join as a listener' : 'That seat is taken' });
        r.seats[idx] = 'me';
        save(s);
        const snap = roomSnapshot(r);
        fire('room:seat', { userId: 'me', seat: idx, isMuted: true, member: snap.viewer });
        fire('room:state', snap);
        run({ seat: idx, peers: [] });
        break;
      }
      case 'seat:leave': {
        const r = s.rooms.find((x) => x.id === this.data.roomId);
        if (r && r.seats.includes('me')) r.seats[r.seats.indexOf('me')] = null;
        save(s);
        if (r) fire('room:state', roomSnapshot(r));
        run({});
        break;
      }
      case 'seat:mute': {
        const r = s.rooms.find((x) => x.id === this.data.roomId);
        if (r) {
          fire('room:seat', { userId: 'me', seat: r.seats.indexOf('me'), isMuted: !!payload?.muted });
        }
        run({ muted: !!payload?.muted });
        break;
      }
      case 'hand:raise': run({ up: !!payload?.up }); break;
      case 'seat:kick': case 'seat:lock': case 'mod:set': case 'room:ban': case 'seat:mute_other': run({}); break;
      case 'room:modlog': run({ log: [] }); break;
      case 'room:update': {
        const r = s.rooms.find((x) => x.id === this.data.roomId);
        if (r) {
          if (payload?.title) r.title = payload.title;
          if (payload?.topic !== undefined) r.topic = payload.topic;
          if (payload?.rules !== undefined) r.rules = payload.rules;
          save(s);
          fire('room:state', roomSnapshot(r));
        }
        run({});
        break;
      }
      case 'room:end': {
        const idx = s.rooms.findIndex((x) => x.id === this.data.roomId);
        if (idx >= 0) { s.rooms.splice(idx, 1); save(s); }
        fire('room:closed', { reason: 'host_ended' });
        run({});
        break;
      }
      case 'chat:send': {
        const r = s.rooms.find((x) => x.id === this.data.roomId);
        if (!r) return ack?.({ ok: false, error: 'Join a room first' });
        const msg = { id: 'm' + Date.now(), kind: 'text', body: payload?.body, userId: 'me', user: s.me, meta: {}, createdAt: Date.now() };
        r.messages.push(msg);
        save(s);
        fire('room:message', msg);
        run({ message: msg });
        break;
      }
      case 'reaction:send': {
        fire('room:reaction', { userId: 'me', displayName: s.me.displayName, emoji: payload?.emoji, at: Date.now() });
        run({});
        break;
      }
      case 'gift:send': {
        const r = s.rooms.find((x) => x.id === this.data.roomId);
        const gift = s.gifts.find((g) => g.id === payload?.giftId);
        const to = r && (r.seats.includes(payload?.toUserId) ? findUser(payload.toUserId) : null);
        if (!r || !gift || !to) return ack?.({ ok: false, error: 'Gift target not in room' });
        const qty = Math.max(1, Math.min(99, Number(payload?.qty) || 1));
        const cost = gift.price * qty;
        if (s.wallet.coins < cost) {
          const e = new Error(`Not enough coins — you need ${cost - s.wallet.coins} more`);
          e.code = 'insufficient_coins';
          return ack?.({ ok: false, error: e.message, code: e.code });
        }
        s.wallet.coins -= cost;
        s.transactions.unshift({ id: 'tg' + Date.now(), delta: -cost, reason: 'gift_sent', createdAt: Date.now() });
        save(s);
        const event = { id: 'ge' + Date.now(), gift: { id: gift.id, name: gift.name, emoji: gift.emoji, price: gift.price }, qty, coins: cost, from: s.me, to: { user: to }, createdAt: Date.now() };
        fire('room:gift', event);
        fire('room:message', { id: 'gm' + Date.now(), kind: 'gift', body: `sent ${gift.emoji} ${gift.name} ×${qty} to ${to.displayName}`, userId: 'me', user: s.me, meta: {}, createdAt: Date.now() });
        run({ coins: s.wallet.coins, event });
        break;
      }
      case 'dm:send': {
        localApi.sendDM(payload?.toUserId, payload?.body).then((r) => run({ message: r.message }));
        break;
      }
      case 'dm:typing': run({}); break;
      case 'presence:ping': run({ ok: true, t: Date.now() }); break;
      case 'rtc:signal': case 'rtc:announce': break; // no real media in local mode
      case 'rtc:speaking': break;
      default: run({});
    }
    return this;
  }
  connect() { return this; }
  disconnect() { this.connected = false; }

  _ambient() {
    const s = ensure();
    const r = s.rooms.find((x) => x.id === this.data.roomId);
    if (!r) return;
    const lines = ['কেমন আছো সবাই? 😄', 'গানটা তো আগুন 🔥', 'মাইক খুলে দাও ভাই 🙏', 'সবাইকে স্বাগতম 🎧'];
    const bot = findUser(r.seats.find((id) => id && id !== 'me') || r.host.id);
    if (!bot) return;
    const msg = { id: 'am' + Date.now(), kind: 'text', body: lines[Math.floor(Math.random() * lines.length)], userId: bot.id, user: bot, meta: {}, createdAt: Date.now() };
    r.messages.push(msg);
    save(s);
    (this.handlers.get('room:message') || []).forEach((f) => f(msg));
  }
}

export function startSimulation(socket) { return socket; }
export function resetLocal() { localStorage.removeItem(LS); S = null; }
