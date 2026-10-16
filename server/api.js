'use strict';

/** REST API — auth, explore feed, profiles, moments, chat, economy. */

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const config = require('./config');
const db = require('./db');
const { all, get, run, now } = db;
const auth = require('./auth');
const state = require('./state');
const dm = require('./dm');
const {
  uid, shortCode, limiter, badRequest, notFound, forbidden, unauthorized,
  cleanText, assertUsername, assertPassword, safeJson, svgAvatar, pick,
} = require('./util');

const loginLimiter = limiter('login', config.limits.loginAttemptsPerMin, 60_000);
const roomLimiter = limiter('room-create', config.limits.roomsCreatedPerHour, 3_600_000);
const followLimiter = limiter('follow', config.limits.followPerMin, 60_000);
const momentLimiter = limiter('moment', config.limits.momentsPerHour, 3_600_000);

const ROOM_CATEGORIES = [
  'broadcast', 'party', 'sing', 'birthday', 'music', 'gaming', 'chat', 'study', 'dance', 'comedy',
];
const THEMES = ['gold', 'rose', 'ocean', 'violet', 'mint', 'sunset', 'night'];

// ---- uploads ---------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 6);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype);
    cb(ok ? null : badRequest('Only JPEG/PNG/WebP/GIF images are allowed'), ok);
  },
});

const router = express.Router();

// ---- helpers ---------------------------------------------------------------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function publicProfile(u, viewerId) {
  const followers = get('SELECT COUNT(*) c FROM follows WHERE target_id = ?', u.id).c;
  const following = get('SELECT COUNT(*) c FROM follows WHERE follower_id = ?', u.id).c;
  const friends = get(
    `SELECT COUNT(*) c FROM follows f1 WHERE f1.follower_id = ?
       AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = f1.target_id AND f2.target_id = ?)`,
    u.id, u.id).c;
  const isFollowing = viewerId
    ? !!get('SELECT 1 FROM follows WHERE follower_id = ? AND target_id = ?', viewerId, u.id)
    : false;
  const moments = get('SELECT COUNT(*) c FROM moments WHERE user_id = ?', u.id).c;
  return {
    ...state.publicUser(u), followers, following, friends, isFollowing, moments,
    createdAt: u.created_at, lastSeenAt: u.last_seen_at,
  };
}

function notify(userId, kind, title, body, meta = {}) {
  const id = uid();
  run('INSERT INTO notifications (id, user_id, kind, title, body, meta, created_at) VALUES (?,?,?,?,?,?,?)',
    id, userId, kind, title, body, JSON.stringify(meta), Date.now());
  return { id, kind, title, body, meta, createdAt: Date.now() };
}

// ===========================================================================
// AUTH
// ===========================================================================
router.post('/auth/register', wrap((req, res) => {
  const ip = req.ip || 'x';
  loginLimiter.hit('reg:' + ip);

  const username = assertUsername(String(req.body.username || '').trim());
  const password = assertPassword(String(req.body.password || ''));
  const displayName = cleanText(req.body.displayName || username, 24, 'name') || username;

  if (get('SELECT 1 FROM users WHERE username = ?', username)) {
    throw badRequest('That username is already taken', 'username_taken');
  }

  const user = {
    id: uid(), username, displayName,
    passwordHash: bcrypt.hashSync(password, 10),
    coins: config.economy.welcomeCoins,
  };
  run(`INSERT INTO users (id, username, display_name, password_hash, avatar, bio, coins, level, role, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    user.id, username, displayName, user.passwordHash, svgAvatar(displayName, username),
    'Hey there! I am on MK Malik 🎙️', user.coins, 1, 'user', Date.now(), Date.now());
  run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
    uid(), user.id, user.coins, 'welcome_bonus', '{}', Date.now());

  const row = get('SELECT * FROM users WHERE id = ?', user.id);
  res.status(201).json({ token: auth.sign(row), user: publicProfile(row, row.id), welcomeCoins: user.coins });
}));

router.post('/auth/login', wrap((req, res) => {
  loginLimiter.hit('login:' + (req.ip || 'x'));
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = get('SELECT * FROM users WHERE username = ?', username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    throw unauthorized('Wrong username or password');
  }
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), row.id);
  res.json({ token: auth.sign(row), user: publicProfile(row, row.id) });
}));

router.post('/auth/guest', wrap((_req, res) => {
  // quick demo login: hand back any seeded demo account
  const demo = get('SELECT * FROM users WHERE username = ?', 'mkmalik');
  if (!demo) throw notFound('Demo account not seeded');
  res.json({ token: auth.sign(demo), user: publicProfile(demo, demo.id) });
}));

router.get('/me', auth.requireAuth, wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json({ user: publicProfile(u, u.id), wallet: { coins: u.coins, diamonds: u.diamonds } });
}));

router.patch('/me', auth.requireAuth, wrap((req, res) => {
  const p = req.body || {};
  const fields = [];
  const args = [];
  if (p.displayName !== undefined) { fields.push('display_name = ?'); args.push(cleanText(p.displayName, 24, 'name') || req.user.display_name); }
  if (p.bio !== undefined) { fields.push('bio = ?'); args.push(cleanText(p.bio, config.limits.maxBioLen, 'bio')); }
  if (p.gender !== undefined && ['male', 'female', 'other', 'any'].includes(p.gender)) { fields.push('gender = ?'); args.push(p.gender); }
  if (p.country !== undefined) { fields.push('country = ?'); args.push(cleanText(p.country, 40, 'country')); }
  if (p.avatar !== undefined) {
    const a = String(p.avatar);
    if (!a.startsWith('data:image/') && !a.startsWith('/uploads/') && !a.startsWith('http')) throw badRequest('Invalid avatar');
    if (a.length > 400_000) throw badRequest('Avatar image too large');
    fields.push('avatar = ?'); args.push(a);
  }
  if (!fields.length) throw badRequest('Nothing to update');
  args.push(req.user.id);
  run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...args);
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json({ user: publicProfile(u, u.id) });
}));

router.post('/me/avatar', auth.requireAuth, upload.single('image'), wrap((req, res) => {
  if (!req.file) throw badRequest('No image uploaded');
  const url = `/uploads/${req.file.filename}`;
  run('UPDATE users SET avatar = ? WHERE id = ?', url, req.user.id);
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json({ user: publicProfile(u, u.id) });
}));

router.post('/me/daily-bonus', auth.requireAuth, wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  const DAY = 86_400_000;
  if (Date.now() - u.last_bonus_at < DAY) {
    const left = Math.ceil((DAY - (Date.now() - u.last_bonus_at)) / 3_600_000);
    throw badRequest(`Already claimed — come back in ~${left}h`, 'bonus_claimed');
  }
  const coins = config.economy.dailyBonus;
  run('UPDATE users SET coins = coins + ?, last_bonus_at = ? WHERE id = ?', coins, Date.now(), u.id);
  run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
    uid(), u.id, coins, 'daily_bonus', '{}', Date.now());
  res.json({ ok: true, coins: u.coins + coins, awarded: coins });
}));

// ===========================================================================
// EXPLORE / ROOMS
// ===========================================================================
router.get('/rooms', auth.optionalAuth, wrap((req, res) => {
  const { category, q, sort = 'hot' } = req.query;
  let cards = state.liveRooms().map(state.card);

  if (category && category !== 'all' && category !== 'related') {
    cards = cards.filter((c) => c.category === category);
  }
  if (q) {
    const needle = String(q).toLowerCase();
    cards = cards.filter((c) =>
      c.title.toLowerCase().includes(needle) ||
      (c.topic || '').toLowerCase().includes(needle) ||
      (c.host?.displayName || '').toLowerCase().includes(needle) ||
      (c.tags || []).some((t) => String(t).toLowerCase().includes(needle)));
  }
  cards.sort((a, b) => {
    if (sort === 'new') return b.createdAt - a.createdAt;
    if (sort === 'seats') return b.seatsFree - a.seatsFree;
    return (b.online * 3 + b.seatsTaken * 2 + b.giftCoins / 500) - (a.online * 3 + a.seatsTaken * 2 + a.giftCoins / 500);
  });

  // "Related" tab biases toward rooms hosted by people you follow.
  if ((category === 'related' || !category) && req.user) {
    const following = new Set(all('SELECT target_id FROM follows WHERE follower_id = ?', req.user.id).map((r) => r.target_id));
    cards = cards.map((c) => ({ ...c, related: following.has(c.host?.id) }))
      .sort((a, b) => (b.related ? 1 : 0) - (a.related ? 1 : 0) || b.online - a.online);
  }

  res.json({
    rooms: cards,
    categories: ROOM_CATEGORIES,
    stats: state.stats(),
  });
}));

router.get('/rooms/:id', auth.optionalAuth, wrap((req, res) => {
  const room = state.loadRoom(req.params.id);
  if (!room) throw notFound('Room not found or closed');
  res.json({ room: state.snapshot(room, req.user?.id) });
}));

router.post('/rooms', auth.requireAuth, wrap((req, res) => {
  roomLimiter.hit(req.user.id);
  const b = req.body || {};
  const title = cleanText(b.title, config.limits.maxRoomTitleLen, 'title') || `${req.user.display_name}'s room`;
  const category = ROOM_CATEGORIES.includes(b.category) ? b.category : 'party';
  const topic = cleanText(b.topic || '', 120, 'topic');
  const tags = Array.isArray(b.tags) ? b.tags.slice(0, 4).map((t) => cleanText(String(t), 16, 'tag')).filter(Boolean) : [];
  const isPrivate = !!b.isPrivate;
  const theme = THEMES.includes(b.theme) ? b.theme : pick(THEMES);

  const id = uid();
  run(`INSERT INTO rooms (id, owner_id, title, topic, category, cover, language, pin_code, is_private, theme, tags, created_at, total_joined)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    id, req.user.id, title, topic, category, b.cover || '', cleanText(b.language || 'any', 20), 
    isPrivate ? shortCode(6) : null, isPrivate ? 1 : 0, theme, JSON.stringify(tags), Date.now());
  run('UPDATE users SET role = ? WHERE id = ? AND role = ?', 'host', req.user.id, 'user');

  const room = state.loadRoom(id);
  res.status(201).json({ room: state.card(room), pin: room.pinCode });
}));

router.post('/rooms/:id/join', auth.requireAuth, wrap((req, res) => {
  const room = state.loadRoom(req.params.id);
  if (!room) throw notFound('Room not found or closed');
  res.json({ roomId: room.id, title: room.title, seatCount: state.SEATS, pinRequired: !!room.pinCode });
}));

// ===========================================================================
// SEARCH / USERS
// ===========================================================================
router.get('/search', auth.optionalAuth, wrap((req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [], rooms: [] });
  const like = `%${q}%`;
  const users = all(
    `SELECT * FROM users WHERE (display_name LIKE ? OR username LIKE ?) AND is_bot IS NOT NULL
     ORDER BY last_seen_at DESC LIMIT 20`, like, like).map((u) => publicProfile(u, req.user?.id));
  const rooms = state.liveRooms().map(state.card)
    .filter((c) => c.title.toLowerCase().includes(q.toLowerCase())).slice(0, 20);
  res.json({ users, rooms });
}));

router.get('/users/:id', auth.optionalAuth, wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) throw notFound('User not found');
  res.json({ user: publicProfile(u, req.user?.id) });
}));

router.post('/users/:id/follow', auth.requireAuth, wrap((req, res) => {
  followLimiter.hit(req.user.id);
  const target = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) throw notFound('User not found');
  if (target.id === req.user.id) throw badRequest('You cannot follow yourself');
  const existing = get('SELECT 1 FROM follows WHERE follower_id = ? AND target_id = ?', req.user.id, target.id);
  if (existing) {
    run('DELETE FROM follows WHERE follower_id = ? AND target_id = ?', req.user.id, target.id);
    return res.json({ following: false });
  }
  run('INSERT INTO follows (follower_id, target_id, created_at) VALUES (?,?,?)', req.user.id, target.id, Date.now());
  const n = notify(target.id, 'follow', 'New follower', `${req.user.display_name} started following you`, { userId: req.user.id });
  res.json({ following: true, notification: n });
}));

router.get('/users/:id/gifts', wrap((req, res) => {
  const rows = all(
    `SELECT g.*, c.name gift_name, c.emoji, u.display_name from_name, u.avatar from_avatar
     FROM gift_events g LEFT JOIN gift_catalog c ON c.id = g.gift_id
     LEFT JOIN users u ON u.id = g.from_id
     WHERE g.to_id = ? ORDER BY g.created_at DESC LIMIT 40`, req.params.id);
  res.json({
    gifts: rows.map((r) => ({
      id: r.id, giftId: r.gift_id, name: r.gift_name || 'Gift', emoji: r.emoji || '🎁',
      qty: r.qty, coins: r.coins, createdAt: r.created_at,
      from: { displayName: r.from_name, avatar: r.from_avatar },
    })),
    total: rows.reduce((s, r) => s + r.coins, 0),
  });
}));

// ===========================================================================
// GIFTS
// ===========================================================================
router.get('/gifts', wrap((_req, res) => {
  res.json({ gifts: all('SELECT * FROM gift_catalog ORDER BY sort, price') });
}));

router.post('/wallet/topup', auth.requireAuth, wrap((req, res) => {
  // Self-hosted deployments have no payment gateway wired up by default.
  // ADMIN_TOPUP_TOKEN gates manual credit; otherwise this stays disabled.
  const token = process.env.ADMIN_TOPUP_TOKEN;
  if (!token || req.body?.token !== token) {
    throw forbidden('Coin top-up requires admin approval on this deployment');
  }
  const amount = Math.max(1, Math.min(1_000_000, Number(req.body?.amount) || 0));
  run('UPDATE users SET coins = coins + ? WHERE id = ?', amount, req.user.id);
  run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
    uid(), req.user.id, amount, 'admin_topup', '{}', Date.now());
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json({ ok: true, coins: u.coins });
}));

// ===========================================================================
// MOMENTS
// ===========================================================================
router.get('/moments', auth.optionalAuth, wrap((req, res) => {
  const rows = all(`SELECT m.*, u.display_name, u.username, u.avatar, u.level, u.vip, u.is_bot
                    FROM moments m JOIN users u ON u.id = m.user_id
                    ORDER BY m.created_at DESC LIMIT 60`);
  const viewer = req.user?.id;
  res.json({
    moments: rows.map((m) => ({
      id: m.id, body: m.body, media: m.media, likes: m.likes, comments: m.comments,
      createdAt: m.created_at, roomId: m.room_id,
      liked: viewer ? !!get('SELECT 1 FROM moment_likes WHERE moment_id = ? AND user_id = ?', m.id, viewer) : false,
      user: { id: m.user_id, displayName: m.display_name, username: m.username, avatar: m.avatar, level: m.level, vip: !!m.vip },
    })),
  });
}));

router.post('/moments', auth.requireAuth, upload.single('image'), wrap((req, res) => {
  momentLimiter.hit(req.user.id);
  const body = cleanText(req.body?.body || '', 500, 'post');
  const media = req.file ? `/uploads/${req.file.filename}` : (req.body?.media || null);
  if (!body && !media) throw badRequest('Write something or add a photo');
  const id = uid();
  run('INSERT INTO moments (id, user_id, body, media, room_id, created_at) VALUES (?,?,?,?,?,?)',
    id, req.user.id, body, media, req.body?.roomId || null, Date.now());
  res.status(201).json({ ok: true, id });
}));

router.post('/moments/:id/like', auth.requireAuth, wrap((req, res) => {
  const m = get('SELECT * FROM moments WHERE id = ?', req.params.id);
  if (!m) throw notFound('Post not found');
  const liked = get('SELECT 1 FROM moment_likes WHERE moment_id = ? AND user_id = ?', m.id, req.user.id);
  if (liked) {
    run('DELETE FROM moment_likes WHERE moment_id = ? AND user_id = ?', m.id, req.user.id);
    run('UPDATE moments SET likes = MAX(0, likes - 1) WHERE id = ?', m.id);
    return res.json({ liked: false, likes: Math.max(0, m.likes - 1) });
  }
  run('INSERT INTO moment_likes (moment_id, user_id, created_at) VALUES (?,?,?)', m.id, req.user.id, Date.now());
  run('UPDATE moments SET likes = likes + 1 WHERE id = ?', m.id);
  if (m.user_id !== req.user.id) {
    notify(m.user_id, 'like', 'New like', `${req.user.display_name} liked your moment`, { momentId: m.id });
  }
  res.json({ liked: true, likes: m.likes + 1 });
}));

router.get('/moments/:id/comments', wrap((req, res) => {
  const rows = all(`SELECT c.*, u.display_name, u.avatar FROM moment_comments c
                    JOIN users u ON u.id = c.user_id WHERE c.moment_id = ? ORDER BY c.created_at`, req.params.id);
  res.json({
    comments: rows.map((c) => ({
      id: c.id, body: c.body, createdAt: c.created_at,
      user: { id: c.user_id, displayName: c.display_name, avatar: c.avatar },
    })),
  });
}));

router.post('/moments/:id/comments', auth.requireAuth, wrap((req, res) => {
  const m = get('SELECT * FROM moments WHERE id = ?', req.params.id);
  if (!m) throw notFound('Post not found');
  const body = cleanText(req.body?.body || '', 200, 'comment');
  if (!body) throw badRequest('Empty comment');
  const id = uid();
  run('INSERT INTO moment_comments (id, moment_id, user_id, body, created_at) VALUES (?,?,?,?,?)',
    id, m.id, req.user.id, body, Date.now());
  run('UPDATE moments SET comments = comments + 1 WHERE id = ?', m.id);
  if (m.user_id !== req.user.id) notify(m.user_id, 'comment', 'New comment', `${req.user.display_name}: ${body.slice(0, 60)}`, { momentId: m.id });
  res.status(201).json({ ok: true, comment: { id, body, createdAt: Date.now(), user: { id: req.user.id, displayName: req.user.display_name, avatar: req.user.avatar } } });
}));

// ===========================================================================
// DIRECT CHAT
// ===========================================================================
router.get('/chat/conversations', auth.requireAuth, wrap((req, res) => {
  res.json({ conversations: dm.listConversations(req.user.id) });
}));

router.get('/chat/:userId/messages', auth.requireAuth, wrap((req, res) => {
  dm.markRead(req.user.id, req.params.userId);
  res.json({ messages: dm.listMessages(req.user.id, req.params.userId, { before: Number(req.query.before) || 0 }) });
}));

router.post('/chat/:userId/messages', auth.requireAuth, wrap((req, res) => {
  const to = get('SELECT * FROM users WHERE id = ?', req.params.userId);
  if (!to) throw notFound('User not found');
  const body = cleanText(req.body?.body || '', config.limits.maxMsgLen, 'message');
  if (!body) throw badRequest('Empty message');
  const msg = dm.sendDirect(req.user, to, body);
  const io = req.app.get('io');
  if (io) io.to(`user:${to.id}`).emit('dm:new', { message: msg, from: state.publicUser(req.user) });
  res.status(201).json({ message: msg });
}));

// ===========================================================================
// NOTIFICATIONS / LEADERBOARD
// ===========================================================================
router.get('/notifications', auth.requireAuth, wrap((req, res) => {
  const rows = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 60', req.user.id);
  res.json({
    notifications: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, meta: safeJson(n.meta, {}), seen: !!n.seen, createdAt: n.created_at })),
    unread: rows.filter((n) => !n.seen).length,
  });
}));

router.post('/notifications/read', auth.requireAuth, wrap((req, res) => {
  run('UPDATE notifications SET seen = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
}));

router.get('/leaderboard', auth.optionalAuth, wrap((req, res) => {
  const period = req.query.period === 'week' ? 7 * 86_400_000 : 86_400_000;
  const since = Date.now() - period;
  const topHosts = all(
    `SELECT u.id, u.display_name, u.username, u.avatar, u.level, u.vip,
            COALESCE(SUM(g.coins), 0) earned
     FROM users u LEFT JOIN gift_events g ON g.to_id = u.id AND g.created_at > ?
     GROUP BY u.id ORDER BY earned DESC, u.level DESC LIMIT 20`, since);
  const topGivers = all(
    `SELECT u.id, u.display_name, u.username, u.avatar, u.level, u.vip,
            COALESCE(SUM(g.coins), 0) spent
     FROM users u LEFT JOIN gift_events g ON g.from_id = u.id AND g.created_at > ?
     GROUP BY u.id ORDER BY spent DESC LIMIT 20`, since);
  res.json({
    period: req.query.period === 'week' ? 'week' : 'day',
    hosts: topHosts, givers: topGivers,
  });
}));

// ===========================================================================
// SERVER HEALTH / SELF-HOSTING
// ===========================================================================
/**
 * ICE servers handed to the browser. Keeping TURN credentials server-side means
 * they are never baked into the client bundle.
 */
router.get('/ice-servers', wrap((_req, res) => {
  const { stun, turnUrl, turnUsername, turnCredential, turnSecret } = config.webrtc;
  const iceServers = [];
  if (stun.length) iceServers.push({ urls: stun });

  if (turnUrl) {
    let username = turnUsername;
    let credential = turnCredential;
    // coturn REST API: time-limited credentials, generated per request
    if (turnSecret) {
      const ttl = 3600 * 12;
      username = String(Math.floor(Date.now() / 1000) + ttl);
      credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
    }
    if (username && credential) {
      iceServers.push({ urls: turnUrl.split(',').map((u) => u.trim()), username, credential });
    }
  }
  res.json({ iceServers, ttl: 3600 });
}));

router.get('/health', wrap((_req, res) => {
  let dbOk = true;
  try { get('SELECT 1 x'); } catch (_) { dbOk = false; }
  res.json({
    ok: dbOk,
    uptimeSec: Math.round(process.uptime()),
    version: require('../package.json').version,
    env: config.env,
    live: state.stats(),
    node: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    startedAt: process.__startedAt || null,
  });
}));

module.exports = { router, publicProfile, notify, ROOM_CATEGORIES, THEMES };
