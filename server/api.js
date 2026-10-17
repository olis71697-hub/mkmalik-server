'use strict';

/** REST API — auth (password / phone OTP / Google), explore feed, profiles,
 *  chat, economy, wallet, moderation and settings. */

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const config = require('./config');
const db = require('./db');
const { all, get, run, tx } = db;
const auth = require('./auth');
const state = require('./state');
const dm = require('./dm');
const realtime = require('./realtime');
const push = require('./push');
const {
  uid, shortCode, limiter, badRequest, notFound, forbidden, unauthorized,
  cleanText, assertUsername, assertPassword, safeJson, svgAvatar, pick,
} = require('./util');

const loginLimiter = limiter('login', config.limits.loginAttemptsPerMin, 60_000);
const roomLimiter = limiter('room-create', config.limits.roomsCreatedPerHour, 3_600_000);
const followLimiter = limiter('follow', config.limits.followPerMin, 60_000);
const momentLimiter = limiter('moment', config.limits.momentsPerHour, 3_600_000);
const otpLimiter = limiter('otp', config.otp.maxPerHour, 3_600_000);

const ROOM_CATEGORIES = [
  'broadcast', 'party', 'sing', 'birthday', 'music', 'gaming', 'chat', 'study', 'dance', 'comedy',
];
const THEMES = ['bamboo', 'gold', 'rose', 'ocean', 'violet', 'mint', 'sunset', 'night'];

/** Coin packages for the Wallet. Prices are display currency (default BDT);
 *  coins are only ever credited after a REAL gateway confirms the payment. */
const COIN_PACKAGES = [
  { id: 'p100',   coins: 100,   price: 20,   label: ' starter',  bonus: 0 },
  { id: 'p520',   coins: 520,   price: 99,   label: ' popular',  bonus: 20 },
  { id: 'p1200',  coins: 1200,  price: 199,  label: ' value',    bonus: 100 },
  { id: 'p3300',  coins: 3300,  price: 499,  label: ' pro',      bonus: 300 },
  { id: 'p7000',  coins: 7000,  price: 999,  label: ' star',     bonus: 1000 },
  { id: 'p18000', coins: 18000, price: 2499, label: ' VIP',      bonus: 3000 },
];

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

/** XP → level curve (gentle early, flat late). */
function levelFromXp(xp) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 80)) + 1;
}
function xpForLevel(level) {
  return Math.pow(Math.max(1, level) - 1, 2) * 80;
}

/** Server-authoritative XP award with level-up notification. */
function awardXp(io, userId, amount) {
  if (!amount) return null;
  const u = get('SELECT * FROM users WHERE id = ?', userId);
  if (!u) return null;
  const xp = u.xp + Math.round(amount);
  let level = u.level;
  let leveledUp = false;
  const target = levelFromXp(xp);
  if (target > level) { level = target; leveledUp = true; }
  run('UPDATE users SET xp = ?, level = ? WHERE id = ?', xp, level, userId);
  if (leveledUp && io) {
    notifyPush(io, userId, 'levelup', `Level ${level}! 🎉`, `অভিনন্দন! আপনি এখন Level ${level} তে পৌঁছেছেন`, { level });
    io.to(`user:${userId}`).emit('user:levelup', { level, xp });
  }
  return { xp, level, leveledUp };
}

/** Notification + realtime push for an online user. */
function notifyPush(io, userId, kind, title, body, meta = {}) {
  const n = notify(userId, kind, title, body, meta);
  if (io) io.to(`user:${userId}`).emit('notification', n);
  return n;
}

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
  const blocked = viewerId
    ? !!get('SELECT 1 FROM blocks WHERE blocker_id = ? AND target_id = ?', viewerId, u.id)
    : false;
  const giftsIn = get('SELECT COUNT(*) c, COALESCE(SUM(coins),0) v FROM gift_events WHERE to_id = ?', u.id);
  const giftsOut = get('SELECT COUNT(*) c, COALESCE(SUM(coins),0) v FROM gift_events WHERE from_id = ?', u.id);
  const roomsHosted = get('SELECT COUNT(*) c FROM rooms WHERE owner_id = ?', u.id).c;
  const settings = getSettings(u.id);
  const online = settings.show_online ? realtime.connected.has(u.id)
    || (Date.now() - (u.last_seen_at || 0) < 30_000 && !!u.is_bot) : false;
  return {
    ...state.publicUser(u), followers, following, friends, isFollowing, blocked,
    giftsReceived: giftsIn.c, giftsReceivedCoins: giftsIn.v,
    giftsSent: giftsOut.c, giftsSentCoins: giftsOut.v,
    roomsHosted, moments: get('SELECT COUNT(*) c FROM moments WHERE user_id = ?', u.id).c,
    createdAt: u.created_at, lastSeenAt: u.last_seen_at, online,
    xp: u.xp || 0, xpNext: xpForLevel((u.level || 1) + 1), xpFloor: xpForLevel(u.level || 1),
    email: viewerId === u.id ? (u.email || null) : undefined,
    phone: viewerId === u.id ? (u.phone || null) : undefined,
    hasPassword: !!(u.password_hash && !u.password_hash.startsWith('!otp')),
  };
}

function notify(userId, kind, title, body, meta = {}) {
  const id = uid();
  run('INSERT INTO notifications (id, user_id, kind, title, body, meta, created_at) VALUES (?,?,?,?,?,?,?)',
    id, userId, kind, title, body, JSON.stringify(meta), Date.now());
  return { id, kind, title, body, meta, createdAt: Date.now() };
}

// ---- settings --------------------------------------------------------------
const DEFAULT_SETTINGS = {
  language: 'bn', theme: 'dark', notify_follow: 1, notify_message: 1, notify_gift: 1,
  notify_invite: 1, dm_privacy: 'everyone', show_online: 1,
};

function getSettings(userId) {
  let row = get('SELECT * FROM user_settings WHERE user_id = ?', userId);
  if (!row) {
    run('INSERT OR IGNORE INTO user_settings (user_id, updated_at) VALUES (?,?)', userId, Date.now());
    row = get('SELECT * FROM user_settings WHERE user_id = ?', userId) || {};
  }
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'user_id' && k !== 'updated_at')) };
}

/** Unique 6-digit display code ("User ID"). */
function assignUserCode() {
  for (let tries = 0; tries < 50; tries++) {
    const code = String(100000 + Math.floor(Math.random() * 900000));
    if (!get('SELECT 1 FROM users WHERE user_code = ?', code)) return code;
  }
  return String(Date.now()).slice(-6);
}

// ---- phone normalisation ---------------------------------------------------
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw badRequest('ফোন নম্বরটি সঠিক নয় (১০–১৫ সংখ্যা হতে হবে)', 'invalid_phone');
  }
  return '+' + digits;
}

// ===========================================================================
// AUTH — username / password
// ===========================================================================
router.post('/auth/register', wrap((req, res) => {
  const ip = req.ip || 'x';
  loginLimiter.hit('reg:' + ip);

  const username = assertUsername(String(req.body.username || '').trim());
  const password = assertPassword(String(req.body.password || ''));
  const displayName = cleanText(req.body.displayName || username, 24, 'name') || username;

  if (get('SELECT 1 FROM users WHERE username = ?', username)) {
    throw badRequest('এই ইউজারনেমটি আগে থেকেই আছে', 'username_taken');
  }

  const user = {
    id: uid(), username, displayName,
    passwordHash: bcrypt.hashSync(password, 10),
    coins: config.economy.welcomeCoins,
  };
  run(`INSERT INTO users (id, username, display_name, password_hash, avatar, bio, coins, level, role, user_code, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    user.id, username, displayName, user.passwordHash, svgAvatar(displayName, username),
    'Panda Voice-এ নতুন 🐼', user.coins, 1, 'user', assignUserCode(), Date.now(), Date.now());
  run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
    uid(), user.id, user.coins, 'welcome_bonus', '{}', Date.now());

  const row = get('SELECT * FROM users WHERE id = ?', user.id);
  res.status(201).json({ token: auth.sign(row), user: publicProfile(row, row.id), welcomeCoins: user.coins });
}));

router.post('/auth/login', wrap((req, res) => {
  loginLimiter.hit('login:' + (req.ip || 'x'));
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = get('SELECT * FROM users WHERE username = ? OR user_code = ?', username, username);
  if (!row || row.password_hash.startsWith('!otp') || !bcrypt.compareSync(password, row.password_hash)) {
    throw unauthorized('ভুল ইউজারনেম বা পাসওয়ার্ড');
  }
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), row.id);
  res.json({ token: auth.sign(row), user: publicProfile(row, row.id) });
}));

// ===========================================================================
// AUTH — phone + OTP
// ===========================================================================
/**
 * Request an OTP for a phone number.
 *
 * No SMS gateway is configured by default, so the code is returned in the
 * response (`devCode`) AND printed in the server log. Set SMS_API_URL +
 * SMS_API_KEY to deliver it for real — until then every response honestly
 * flags `delivery: 'console'`.
 */
router.post('/auth/otp/request', wrap(async (req, res) => {
  loginLimiter.hit('otp:' + (req.ip || 'x'));
  const phone = normalizePhone(req.body?.phone);
  otpLimiter.hit(phone);

  // No SMS gateway → the honest answer is "not available". No code is ever
  // printed on screen in a real deployment. (OTP_DEV_BYPASS=1 re-enables
  // console delivery for local development, on purpose.)
  if (!config.otp.smsApiUrl && !config.otp.devBypass) {
    throw Object.assign(
      new Error('SMS গেটওয়ে সংযোগ করা হয়নি — ফোন নম্বর দিয়ে লগইন এখন চালু নেই। ইউজারনেম/পাসওয়ার্ড ব্যবহার করুন (সার্ভারে SMS_API_URL সেট হলে চালু হবে)'),
      { status: 503, code: 'sms_not_configured' });
  }

  // purge expired codes for this number
  run('DELETE FROM otp_codes WHERE phone = ? AND expires_at < ?', phone, Date.now());

  const code = String(crypto.randomInt(100000, 999999));
  run('INSERT INTO otp_codes (id, phone, code, purpose, expires_at, created_at) VALUES (?,?,?,?,?,?)',
    uid(), phone, code, 'login', Date.now() + config.otp.ttlMs, Date.now());

  let delivery = 'console';
  let delivered = false;
  if (config.otp.smsApiUrl) {
    try {
      const r = await fetch(config.otp.smsApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.otp.smsApiKey },
        body: JSON.stringify({ to: phone, from: config.otp.smsFrom, text: `Panda Voice কোড: ${code}` }),
      });
      delivered = r.ok;
      delivery = delivered ? 'sms' : 'sms_failed';
    } catch (_) { delivery = 'sms_failed'; }
  }
  if (!delivered) {
    console.log(`[otp] ${phone} → ${code}   (SMS gateway not configured — shown here)`);
  }

  const existing = !!get('SELECT 1 FROM users WHERE phone = ?', phone);
  res.json({
    ok: true, phone, exists: existing,
    delivery, ttlSec: Math.round(config.otp.ttlMs / 1000),
    // only an explicit OTP_DEV_BYPASS=1 ever surfaces the code to the client
    devCode: !delivered && config.otp.devBypass ? code : undefined,
  });
}));

/** Verify the OTP → logs the account in, or creates it on first use. */
router.post('/auth/otp/verify', wrap((req, res) => {
  loginLimiter.hit('otpv:' + (req.ip || 'x'));
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  const row = get('SELECT * FROM otp_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1', phone);
  if (!row || row.expires_at < Date.now()) throw badRequest('কোডের সময় শেষ — আবার চেষ্টা করুন', 'otp_expired');
  if (row.attempts >= 5) throw badRequest('অনেকবার ভুল কোড — নতুন কোড নিন', 'otp_locked');
  if (row.code !== code) {
    run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    throw badRequest('ভুল কোড', 'otp_wrong');
  }
  run('DELETE FROM otp_codes WHERE id = ?', row.id);

  let user = get('SELECT * FROM users WHERE phone = ?', phone);
  let created = false;
  if (!user) {
    const displayName = cleanText(req.body?.displayName || '', 24, 'name') || ('Panda ' + phone.slice(-4));
    let username = 'user' + phone.replace(/\D/g, '').slice(-8);
    while (get('SELECT 1 FROM users WHERE username = ?', username)) username += Math.floor(Math.random() * 90 + 10);
    const id = uid();
    const coins = config.economy.welcomeCoins;
    run(`INSERT INTO users (id, username, display_name, password_hash, avatar, bio, phone, coins,
                            level, role, user_code, created_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, username, displayName, '!otp:' + uid(), svgAvatar(displayName, username), 'Panda Voice-এ নতুন 🐼',
      phone, coins, 1, 'user', assignUserCode(), Date.now(), Date.now());
    run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
      uid(), id, coins, 'welcome_bonus', '{}', Date.now());
    user = get('SELECT * FROM users WHERE id = ?', id);
    created = true;
  }
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), user.id);
  res.json({ token: auth.sign(user), user: publicProfile(user, user.id), created, welcomeCoins: created ? config.economy.welcomeCoins : 0 });
}));

// ===========================================================================
// AUTH — Google Sign-In
// ===========================================================================
/**
 * Exchange a Google Identity Services credential (JWT) for a session.
 *
 * Requires GOOGLE_CLIENT_ID (the Web client OAuth ID from Google Cloud
 * Console). Without it this endpoint answers 503 with setup instructions —
 * it never pretends to work.
 */
let googleCerts = { at: 0, keys: null };
async function googleCertsPem() {
  if (googleCerts.keys && Date.now() - googleCerts.at < 3600_000) return googleCerts.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v1/certs', { cache: 'no-store' });
  if (!res.ok) throw new Error('Google certs unreachable');
  googleCerts = { at: Date.now(), keys: await res.json() };
  return googleCerts.keys;
}

router.post('/auth/google', wrap(async (req, res) => {
  if (!config.googleClientId) {
    throw Object.assign(new Error('Google Sign-In কনফিগার করা হয়নি — সার্ভারে GOOGLE_CLIENT_ID সেট করুন'), { status: 503, code: 'google_not_configured' });
  }
  const credential = String(req.body?.credential || '');
  if (!credential) throw badRequest('Missing Google credential');

  const decoded = jwt.decode(credential, { complete: true });
  const kid = decoded?.header?.kid;
  const certs = await googleCertsPem();
  const pem = certs && kid ? certs[kid] : null;
  if (!pem) throw badRequest('Unknown Google signing key', 'google_bad_token');

  let payload;
  try {
    payload = jwt.verify(credential, pem, {
      audience: config.googleClientId,
      issuer: ['accounts.google.com', 'https://accounts.google.com'],
    });
  } catch (e) {
    throw Object.assign(new Error('Google টোকেন যাচাই হয়নি: ' + e.message), { status: 401, code: 'google_invalid' });
  }

  let user = get('SELECT * FROM users WHERE google_id = ?', payload.sub);
  let created = false;
  if (!user) {
    const email = payload.email || (payload.sub + '@google');
    user = get('SELECT * FROM users WHERE email = ?', email);
    if (user) {
      run('UPDATE users SET google_id = ? WHERE id = ?', payload.sub, user.id);
    } else {
      const displayName = cleanText(payload.name || 'Google User', 24, 'name') || 'Google User';
      let username = 'g_' + payload.sub.slice(0, 12);
      while (get('SELECT 1 FROM users WHERE username = ?', username)) username += Math.floor(Math.random() * 90 + 10);
      const id = uid();
      const coins = config.economy.welcomeCoins;
      run(`INSERT INTO users (id, username, display_name, password_hash, avatar, bio, email, google_id,
                              coins, level, role, user_code, created_at, last_seen_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, username, displayName, '!otp:' + uid(), payload.picture || svgAvatar(displayName, username),
        'Panda Voice-এ নতুন 🐼', email, payload.sub, coins, 1, 'user', assignUserCode(), Date.now(), Date.now());
      run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
        uid(), id, coins, 'welcome_bonus', '{}', Date.now());
      user = get('SELECT * FROM users WHERE id = ?', id);
      created = true;
    }
  }
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), user.id);
  res.json({ token: auth.sign(user), user: publicProfile(user, user.id), created });
}));

// ===========================================================================
// AUTH — password reset (code shown in server log / dev response)
// ===========================================================================
router.post('/auth/forgot', wrap((req, res) => {
  loginLimiter.hit('forgot:' + (req.ip || 'x'));
  const handle = String(req.body?.username || '').trim();
  const user = get('SELECT * FROM users WHERE username = ? OR user_code = ? OR phone = ?',
    handle, handle, handle.startsWith('+') ? handle : '+' + handle.replace(/\D/g, ''));
  // Always answer the same way — never reveal whether the account exists.
  const code = String(crypto.randomInt(100000, 999999));
  if (user) {
    run('DELETE FROM otp_codes WHERE phone = ? AND purpose = ?', 'reset:' + user.id, 'reset');
    run('INSERT INTO otp_codes (id, phone, code, purpose, expires_at, created_at) VALUES (?,?,?,?,?,?)',
      uid(), 'reset:' + user.id, code, 'reset', Date.now() + config.otp.ttlMs, Date.now());
    console.log(`[reset] ${user.username} → recovery code ${code}   (shown here; wire SMTP/SMS to deliver)`);
  }
  res.json({ ok: true, ttlSec: Math.round(config.otp.ttlMs / 1000), devCode: user ? code : undefined });
}));

router.post('/auth/reset', wrap((req, res) => {
  loginLimiter.hit('reset:' + (req.ip || 'x'));
  const handle = String(req.body?.username || '').trim();
  const code = String(req.body?.code || '').trim();
  const password = assertPassword(String(req.body?.password || ''));
  const user = get('SELECT * FROM users WHERE username = ? OR user_code = ?', handle, handle);
  if (!user) throw badRequest('অ্যাকাউন্ট পাওয়া যায়নি', 'no_account');
  const row = get("SELECT * FROM otp_codes WHERE phone = ? AND purpose = 'reset' ORDER BY created_at DESC LIMIT 1", 'reset:' + user.id);
  if (!row || row.expires_at < Date.now() || row.code !== code) {
    throw badRequest('ভুল বা মেয়াদোত্তীর্ণ রিকভারি কোড', 'reset_bad_code');
  }
  run('DELETE FROM otp_codes WHERE id = ?', row.id);
  run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), user.id);
  res.json({ ok: true });
}));

// ===========================================================================
// ME / PROFILE
// ===========================================================================
router.get('/me', auth.requireAuth, wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json({
    user: publicProfile(u, u.id),
    wallet: { coins: u.coins, diamonds: u.diamonds },
    settings: getSettings(u.id),
  });
}));

router.patch('/me', auth.requireAuth, wrap((req, res) => {
  const p = req.body || {};
  const fields = [];
  const args = [];
  if (p.displayName !== undefined) { fields.push('display_name = ?'); args.push(cleanText(p.displayName, 24, 'name') || req.user.display_name); }
  if (p.bio !== undefined) { fields.push('bio = ?'); args.push(cleanText(p.bio, config.limits.maxBioLen, 'bio')); }
  if (p.gender !== undefined && ['male', 'female', 'other', 'any'].includes(p.gender)) { fields.push('gender = ?'); args.push(p.gender); }
  if (p.country !== undefined) { fields.push('country = ?'); args.push(cleanText(p.country, 40, 'country')); }
  if (p.language !== undefined) { fields.push('language = ?'); args.push(cleanText(p.language, 20, 'language')); }
  if (p.email !== undefined && p.email !== null && p.email !== '') {
    const email = cleanText(p.email, 120, 'email');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('ইমেইলটি সঠিক নয়');
    fields.push('email = ?'); args.push(email);
  }
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

/** Change password (signed-in user). */
router.post('/me/password', auth.requireAuth, wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  const current = String(req.body?.currentPassword || '');
  const next = assertPassword(String(req.body?.newPassword || ''));
  if (!u.password_hash.startsWith('!otp')) {
    if (!bcrypt.compareSync(current, u.password_hash)) throw forbidden('বর্তমান পাসওয়ার্ড ভুল');
  }
  run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(next, 10), u.id);
  res.json({ ok: true });
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
    throw badRequest(`ইতিমধ্যে নেওয়া হয়েছে — ~${left} ঘণ্টা পরে আসুন`, 'bonus_claimed');
  }
  const coins = config.economy.dailyBonus;
  run('UPDATE users SET coins = coins + ?, last_bonus_at = ? WHERE id = ?', coins, Date.now(), u.id);
  run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
    uid(), u.id, coins, 'daily_bonus', '{}', Date.now());
  awardXp(req.app.get('io'), u.id, 10);
  res.json({ ok: true, coins: u.coins + coins, awarded: coins });
}));

/** Settings (language, theme, notifications, privacy). */
router.get('/me/settings', auth.requireAuth, wrap((req, res) => {
  res.json({ settings: getSettings(req.user.id) });
}));

// ===========================================================================
// WEB PUSH — real VAPID notifications (Android/desktop, work when closed)
// ===========================================================================

/** Public VAPID key — the browser needs it to create a subscription. */
router.get('/push/key', wrap((_req, res) => {
  res.json({ publicKey: push.publicKey() });
}));

/** Which of this user's browsers are registered. */
router.get('/push/status', auth.requireAuth, wrap((req, res) => {
  res.json(push.status(req.user.id));
}));

/** Register this browser (the client sends the PushSubscription object). */
router.post('/push/subscribe', auth.requireAuth, wrap((req, res) => {
  push.subscribe(req.user.id, req.body);
  res.json({ ok: true, ...push.status(req.user.id) });
}));

/** Unregister one browser. */
router.post('/push/unsubscribe', auth.requireAuth, wrap((req, res) => {
  push.unsubscribe(req.user.id, req.body?.endpoint);
  res.json({ ok: true, ...push.status(req.user.id) });
}));

/** Send a real test push to this user's browsers. */
router.post('/push/test', auth.requireAuth, wrap(async (req, res) => {
  const r = await push.sendToUser(req.user.id, {
    kind: 'test', title: 'Panda Voice 🐼',
    body: 'পুশ নোটিফিকেশন চালু আছে ✓', tag: 'panda-test', url: './',
  });
  res.json({
    ok: r.sent > 0, sent: r.sent, skipped: r.skipped || null,
    error: r.sent ? null : (r.skipped === 'settings'
      ? 'সেটিংসে এই নোটিফিকেশন বন্ধ আছে'
      : r.skipped === 'online'
        ? 'আপনি এখন অনলাইন — পুশ শুধু দূরে থাকলে যায়'
        : r.skipped === 'no_subscription'
          ? 'কোনো ব্রাউজার রেজিস্টার করা নেই'
          : 'push সার্ভিসে পৌঁছানো যায়নি — সার্ভার থেকে push service reachable হতে হবে'),
  });
}));

router.put('/me/settings', auth.requireAuth, wrap((req, res) => {
  const p = req.body || {};
  const s = getSettings(req.user.id);
  const next = {
    language: ['bn', 'en'].includes(p.language) ? p.language : s.language,
    theme: ['dark', 'light'].includes(p.theme) ? p.theme : s.theme,
    notify_follow: p.notify_follow !== undefined ? (p.notify_follow ? 1 : 0) : s.notify_follow,
    notify_message: p.notify_message !== undefined ? (p.notify_message ? 1 : 0) : s.notify_message,
    notify_gift: p.notify_gift !== undefined ? (p.notify_gift ? 1 : 0) : s.notify_gift,
    notify_invite: p.notify_invite !== undefined ? (p.notify_invite ? 1 : 0) : s.notify_invite,
    dm_privacy: ['everyone', 'following', 'nobody'].includes(p.dm_privacy) ? p.dm_privacy : s.dm_privacy,
    show_online: p.show_online !== undefined ? (p.show_online ? 1 : 0) : s.show_online,
  };
  run(`INSERT INTO user_settings (user_id, language, theme, notify_follow, notify_message, notify_gift,
                                  notify_invite, dm_privacy, show_online, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET language=excluded.language, theme=excluded.theme,
         notify_follow=excluded.notify_follow, notify_message=excluded.notify_message,
         notify_gift=excluded.notify_gift, notify_invite=excluded.notify_invite,
         dm_privacy=excluded.dm_privacy, show_online=excluded.show_online, updated_at=excluded.updated_at`,
    req.user.id, next.language, next.theme, next.notify_follow, next.notify_message,
    next.notify_gift, next.notify_invite, next.dm_privacy, next.show_online, Date.now());
  res.json({ settings: getSettings(req.user.id) });
}));

/** Delete my account and all my data. */
router.delete('/me', auth.requireAuth, wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  const io = req.app.get('io');
  if (!u.password_hash.startsWith('!otp')) {
    const pw = String(req.body?.password || '');
    if (!bcrypt.compareSync(pw, u.password_hash)) throw forbidden('পাসওয়ার্ড ভুল — অ্যাকাউন্ট ডিলিট করা যায়নি');
  } else if (req.body?.confirm !== true) {
    throw badRequest('Confirm with {confirm: true} to delete the account');
  }
  // leave any live room first
  for (const room of state.liveRooms()) {
    if (room.members.has(u.id)) state.leave(room.id, u.id, 'left');
  }
  // close rooms they own
  for (const room of state.liveRooms()) {
    if (room.ownerId === u.id) {
      if (io) io.to(`room:${room.id}`).emit('room:closed', { reason: 'host_ended' });
      state.closeRoom(room.id, 'owner_deleted');
    }
  }
  run('DELETE FROM users WHERE id = ?', u.id);   // cascades everywhere
  res.json({ ok: true, deleted: true });
}));

// ===========================================================================
// BLOCKS
// ===========================================================================
router.get('/me/blocks', auth.requireAuth, wrap((req, res) => {
  const rows = all(
    `SELECT u.* FROM blocks b JOIN users u ON u.id = b.target_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
    req.user.id);
  res.json({ blocked: rows.map((u) => state.publicUser(u)) });
}));

router.post('/users/:id/block', auth.requireAuth, wrap((req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) throw notFound('User not found');
  if (target.id === req.user.id) throw badRequest('নিজেকে ব্লক করা যায় না');
  run('INSERT OR IGNORE INTO blocks (blocker_id, target_id, created_at) VALUES (?,?,?)', req.user.id, target.id, Date.now());
  // blocking also removes the follow both ways
  run('DELETE FROM follows WHERE (follower_id = ? AND target_id = ?) OR (follower_id = ? AND target_id = ?)',
    req.user.id, target.id, target.id, req.user.id);
  res.json({ blocked: true });
}));

router.delete('/users/:id/block', auth.requireAuth, wrap((req, res) => {
  run('DELETE FROM blocks WHERE blocker_id = ? AND target_id = ?', req.user.id, req.params.id);
  res.json({ blocked: false });
}));

// ===========================================================================
// REPORTS
// ===========================================================================
router.post('/report', auth.requireAuth, wrap((req, res) => {
  const type = req.body?.targetType === 'room' ? 'room' : 'user';
  const targetId = String(req.body?.targetId || '');
  if (!targetId) throw badRequest('targetId required');
  const REASONS = ['spam', 'abuse', 'sexual', 'violence', 'underage', 'other'];
  const reason = REASONS.includes(req.body?.reason) ? req.body.reason : 'other';
  const note = cleanText(req.body?.note || '', 300, 'note');
  const id = uid();
  run('INSERT INTO reports (id, reporter_id, target_type, target_id, reason, note, created_at) VALUES (?,?,?,?,?,?,?)',
    id, req.user.id, type, targetId, reason, note, Date.now());
  // let every admin know
  const io = req.app.get('io');
  for (const admin of all("SELECT id FROM users WHERE role = 'admin'")) {
    notifyPush(io, admin.id, 'report', 'নতুন রিপোর্ট', `${type === 'room' ? 'রুম' : 'ইউজার'} রিপোর্ট করা হয়েছে (${reason})`, { reportId: id });
  }
  res.status(201).json({ ok: true, reportId: id });
}));

// ===========================================================================
// EXPLORE / ROOMS
// ===========================================================================
router.get('/rooms', auth.optionalAuth, wrap((req, res) => {
  const { category, q, sort = 'hot', language } = req.query;
  let cards = state.liveRooms().map(state.card);

  if (category && category !== 'all' && category !== 'related') {
    cards = cards.filter((c) => c.category === category);
  }
  if (language && language !== 'any') {
    cards = cards.filter((c) => c.language === language || c.language === 'any');
  }
  if (q) {
    const needle = String(q).toLowerCase();
    cards = cards.filter((c) =>
      c.title.toLowerCase().includes(needle) ||
      (c.topic || '').toLowerCase().includes(needle) ||
      c.id.toLowerCase().includes(needle) ||
      (c.host?.displayName || '').toLowerCase().includes(needle));
  }
  if (sort === 'new') {
    cards.sort((a, b) => b.createdAt - a.createdAt);
  } else if (sort === 'trending') {
    cards.sort((a, b) => (b.peakUsers + b.totalJoined + b.giftCoins / 100) - (a.peakUsers + a.totalJoined + a.giftCoins / 100));
  } else if (sort === 'followed' && req.user) {
    const followed = new Set(all('SELECT target_id FROM follows WHERE follower_id = ?', req.user.id).map((r) => r.target_id));
    cards = cards.filter((c) => followed.has(c.host?.id));
  } else if (sort === 'related' && req.user) {
    const followed = new Set(all('SELECT target_id FROM follows WHERE follower_id = ?', req.user.id).map((r) => r.target_id));
    cards.sort((a, b) => ((followed.has(b.host?.id) ? 1 : 0) - (followed.has(a.host?.id) ? 1 : 0)) || b.online - a.online);
  } else {
    // hot
    cards.sort((a, b) => b.online - a.online || b.seatsTaken - a.seatsTaken);
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
  const title = cleanText(b.title, config.limits.maxRoomTitleLen, 'title') || `${req.user.display_name}-এর রুম`;
  const category = ROOM_CATEGORIES.includes(b.category) ? b.category : 'party';
  const topic = cleanText(b.topic || '', 120, 'topic');
  const rules = cleanText(b.rules || '', 300, 'rules');
  const tags = Array.isArray(b.tags) ? b.tags.slice(0, 4).map((t) => cleanText(String(t), 16, 'tag')).filter(Boolean) : [];
  const isPrivate = !!b.isPrivate;
  const theme = THEMES.includes(b.theme) ? b.theme : pick(THEMES);

  const id = uid();
  run(`INSERT INTO rooms (id, owner_id, title, topic, category, cover, language, pin_code, is_private, theme, tags, rules, created_at, total_joined)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    id, req.user.id, title, topic, category, b.cover || '', cleanText(b.language || 'any', 20),
    isPrivate ? shortCode(6) : null, isPrivate ? 1 : 0, theme, JSON.stringify(tags), rules, Date.now());
  run('UPDATE users SET role = ? WHERE id = ? AND role = ?', 'host', req.user.id, 'user');

  const room = state.loadRoom(id);

  // ---- the host went live: tell everyone who follows them -----------------
  // A row in notifications + a live socket event when they are online, a real
  // Web Push when they are not. Room creation is rate-limited per user, so
  // this can never become spam.
  if (!isPrivate) {
    const io = req.app.get('io');
    const followers = all('SELECT follower_id FROM follows WHERE target_id = ? LIMIT 500', req.user.id);
    for (const f of followers) {
      if (!getSettings(f.follower_id).notify_follow) continue;
      const n = notify(f.follower_id, 'live', `${req.user.display_name} is live 🔴`,
        `${title} — এখনই যোগ দিন`, { roomId: id, hostId: req.user.id });
      try { if (io) io.to(`user:${f.follower_id}`).emit('notification', n); } catch (_) {}
      push.sendToUser(f.follower_id, {
        kind: 'live', title: `${req.user.display_name} is live 🔴`,
        body: title, tag: 'live-' + id, url: './#room=' + id,
      }).catch(() => {});
    }
  }

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
  let users = all(
    `SELECT * FROM users
     WHERE (display_name LIKE ? OR username LIKE ? OR user_code = ?)
     ORDER BY last_seen_at DESC LIMIT 20`, like, like, q);
  // hide users who blocked the viewer or whom the viewer blocked
  if (req.user) {
    users = users.filter((u) => u.id !== req.user.id && !get(
      'SELECT 1 FROM blocks WHERE (blocker_id = ? AND target_id = ?) OR (blocker_id = ? AND target_id = ?)',
      req.user.id, u.id, u.id, req.user.id));
  }
  const rooms = state.liveRooms().map(state.card)
    .filter((c) => c.title.toLowerCase().includes(q.toLowerCase()) || c.id.toLowerCase() === q.toLowerCase()).slice(0, 20);
  res.json({ users: users.map((u) => publicProfile(u, req.user?.id)), rooms });
}));

/** People directory for Discover — new / popular / live. */
router.get('/users', auth.optionalAuth, wrap((req, res) => {
  const sort = String(req.query.sort || 'popular');
  let rows;
  if (sort === 'new') {
    rows = all('SELECT * FROM users ORDER BY created_at DESC LIMIT 30');
  } else if (sort === 'live') {
    rows = all('SELECT * FROM users ORDER BY last_seen_at DESC LIMIT 40');
  } else {
    rows = all(
      `SELECT u.*, (SELECT COUNT(*) FROM follows f WHERE f.target_id = u.id) followers
       FROM users u ORDER BY followers DESC, u.level DESC LIMIT 30`);
  }
  const viewer = req.user?.id;
  const filtered = rows.filter((u) => {
    if (viewer && u.id === viewer) return false;
    if (viewer && get('SELECT 1 FROM blocks WHERE (blocker_id = ? AND target_id = ?) OR (blocker_id = ? AND target_id = ?)',
      viewer, u.id, u.id, viewer)) return false;
    return true;
  });
  res.json({ users: filtered.map((u) => publicProfile(u, viewer)), sort });
}));

router.get('/users/:id', auth.optionalAuth, wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ? OR user_code = ?', req.params.id, req.params.id);
  if (!u) throw notFound('User not found');
  res.json({ user: publicProfile(u, req.user?.id) });
}));

router.post('/users/:id/follow', auth.requireAuth, wrap((req, res) => {
  followLimiter.hit(req.user.id);
  const target = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) throw notFound('User not found');
  if (target.id === req.user.id) throw badRequest('নিজেকে ফলো করা যায় না');
  const blocked = get('SELECT 1 FROM blocks WHERE (blocker_id = ? AND target_id = ?) OR (blocker_id = ? AND target_id = ?)',
    req.user.id, target.id, target.id, req.user.id);
  if (blocked) throw forbidden('এই ইউজার ব্লক করা আছে');
  const existing = get('SELECT 1 FROM follows WHERE follower_id = ? AND target_id = ?', req.user.id, target.id);
  if (existing) {
    run('DELETE FROM follows WHERE follower_id = ? AND target_id = ?', req.user.id, target.id);
    return res.json({ following: false });
  }
  run('INSERT INTO follows (follower_id, target_id, created_at) VALUES (?,?,?)', req.user.id, target.id, Date.now());
  const settings = getSettings(target.id);
  const n = notify(target.id, 'follow', 'New follower', `${req.user.display_name} এখন আপনাকে ফলো করছে`, { userId: req.user.id });
  if (settings.notify_follow) {
    const io = req.app.get('io');
    if (io) io.to(`user:${target.id}`).emit('notification', n);
    // real Android/desktop push when they are away
    push.sendToUser(target.id, {
      kind: 'follow', title: 'New follower 🐼',
      body: `${req.user.display_name} এখন আপনাকে ফলো করছে`, tag: 'follow', url: './',
    }).catch(() => {});
  }
  res.json({ following: true, notification: n });
}));

router.get('/users/:id/followers', auth.optionalAuth, wrap((req, res) => {
  const rows = all(
    `SELECT u.* FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.target_id = ?
     ORDER BY f.created_at DESC LIMIT 100`, req.params.id);
  res.json({ users: rows.map((u) => publicProfile(u, req.user?.id)) });
}));

router.get('/users/:id/following', auth.optionalAuth, wrap((req, res) => {
  const rows = all(
    `SELECT u.* FROM follows f JOIN users u ON u.id = f.target_id WHERE f.follower_id = ?
     ORDER BY f.created_at DESC LIMIT 100`, req.params.id);
  res.json({ users: rows.map((u) => publicProfile(u, req.user?.id)) });
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

// ===========================================================================
// WALLET
// ===========================================================================
router.get('/wallet', auth.requireAuth, wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  const tx = all(
    `SELECT l.*, p.status pay_status, p.payment_ref, p.payment_method
     FROM coin_ledger l LEFT JOIN purchases p ON p.id = l.meta
     WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 60`, req.user.id);
  return res.json({
    wallet: { coins: u.coins, diamonds: u.diamonds },
    transactions: tx.map((t) => ({
      id: t.id, delta: t.delta, reason: t.reason,
      meta: safeJson(t.meta, {}), createdAt: t.created_at,
    })),
  });
}));

router.get('/wallet/packages', wrap((_req, res) => {
  res.json({
    packages: COIN_PACKAGES.map((p) => ({ ...p, currency: config.payments.currency })),
    mode: config.payments.mode,
    exchange: { feePct: 10, minDiamonds: 10 },
    methods: [
      { id: 'bkash', label: 'bKash', emoji: '📱' },
      { id: 'nagad', label: 'Nagad', emoji: '💸' },
      { id: 'card', label: 'Card', emoji: '💳' },
    ],
  });
}));

/**
 * Diamond → coin exchange (server-authoritative, no gateway involved).
 * Gift diamonds become spendable coins at a 10% platform fee; the minimum
 * keeps the ledger clean.
 */
router.post('/wallet/exchange', auth.requireAuth, wrap((req, res) => {
  const diamonds = Math.floor(Number(req.body?.diamonds || 0));
  if (!Number.isFinite(diamonds) || diamonds < 10) {
    throw badRequest('সর্বনিম্ন ১০ ডায়মন্ড এক্সচেঞ্জ করা যায়', 'exchange_min');
  }
  const u0 = get('SELECT coins, diamonds FROM users WHERE id = ?', req.user.id);
  if (u0.diamonds < diamonds) throw badRequest('পর্যাপ্ত ডায়মন্ড নেই', 'insufficient_diamonds');

  const fee = Math.ceil((diamonds * 10) / 100);
  const coins = diamonds - fee;
  const t = Date.now();
  tx(() => {
    run('UPDATE users SET diamonds = diamonds - ?, coins = coins + ? WHERE id = ? AND diamonds >= ?',
      diamonds, coins, req.user.id, diamonds);
    run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
      uid(), req.user.id, coins, 'exchange', JSON.stringify({ diamonds, fee }), t);
  });
  const u = get('SELECT coins, diamonds FROM users WHERE id = ?', req.user.id);
  res.json({ ok: true, exchanged: diamonds, fee, credited: coins, coins: u.coins, diamonds: u.diamonds });
}));

/**
 * Buy coins — REAL gateway only.
 *
 * PAYMENTS_MODE=live + PURCHASE_VERIFY_URL: the server calls the gateway with
 * the payment reference BEFORE crediting a single coin, and only credits when
 * the gateway says paid. Anything else (no gateway configured) is refused with
 * 503 payments_not_configured — coins are never invented. UNIQUE(payment_ref)
 * keeps double-crediting impossible.
 */
router.post('/wallet/purchase', auth.requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const pkg = COIN_PACKAGES.find((p) => p.id === String(b.packageId || ''));
  if (!pkg) throw badRequest('Unknown package');
  const ref = String(b.paymentRef || '').trim();
  const method = String(b.paymentMethod || 'unspecified');
  if (!/^[A-Za-z0-9-]{8,48}$/.test(ref)) throw badRequest('Invalid payment reference', 'bad_ref');

  // idempotency: the same reference can never be charged twice
  const existing = get('SELECT * FROM purchases WHERE payment_ref = ?', ref);
  if (existing) {
    if (existing.status === 'success' && existing.user_id === req.user.id) {
      return res.json({ ok: true, already: true, status: 'success', coins: get('SELECT coins FROM users WHERE id = ?', req.user.id).coins, purchaseId: existing.id });
    }
    if (existing.status === 'success') throw forbidden('এই পেমেন্ট রেফারেন্স আগেই ব্যবহার হয়েছে', 'ref_reused');
    throw badRequest('একটি পেমেন্ট ইতিমধ্যে pending/failed — নতুন রেফারেন্স দিন', 'ref_pending');
  }

  // ---- gateway verification -----------------------------------------------
  // Real payments only. Coins are credited solely when a configured gateway
  // (PAYMENTS_MODE=live + PURCHASE_VERIFY_URL) confirms the reference — an
  // unconfigured deployment refuses the purchase instead of faking it.
  if (config.payments.mode !== 'live' || !config.payments.verifyUrl) {
    throw Object.assign(
      new Error('পেমেন্ট গেটওয়ে এখনো সংযোগ করা হয়নি — আসল টাকায় কয়েন কেনা চালু নেই (সার্ভারে PAYMENTS_MODE=live ও PURCHASE_VERIFY_URL সেট করুন)'),
      { status: 503, code: 'payments_not_configured' });
  }
  let paid = false;
  const gateway = 'live';
  try {
    const r = await fetch(config.payments.verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.payments.verifyKey },
      body: JSON.stringify({ ref, packageId: pkg.id, amount: pkg.price, currency: config.payments.currency }),
    });
    const data = await r.json().catch(() => null);
    paid = r.ok && data?.paid === true;
  } catch (_) { paid = false; }

  const id = uid();
  const t = Date.now();
  run(`INSERT INTO purchases (id, user_id, package_id, coins, price, currency, payment_ref, payment_method, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, req.user.id, pkg.id, pkg.coins, String(pkg.price), config.payments.currency, ref, method,
    paid ? 'success' : 'failed', t);

  if (!paid) {
    return res.status(402).json({ error: 'পেমেন্ট যাচাই হয়নি — কয়েন যোগ হয়নি', code: 'payment_failed', purchaseId: id, status: 'failed' });
  }

  const total = pkg.coins + pkg.bonus;
  run('UPDATE users SET coins = coins + ? WHERE id = ?', total, req.user.id);
  run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
    uid(), req.user.id, total, 'purchase', JSON.stringify(id), t);

  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.status(201).json({
    ok: true, status: 'success', purchaseId: id, credited: total,
    coins: u.coins, gateway, package: pkg,
  });
}));

/** Manual top-up for admins / support (kept from the original deployment). */
router.post('/wallet/topup', auth.requireAuth, wrap((req, res) => {
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
// MOMENTS (kept for API compatibility)
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
  if (get('SELECT 1 FROM blocks WHERE (blocker_id = ? AND target_id = ?) OR (blocker_id = ? AND target_id = ?)',
    req.user.id, to.id, to.id, req.user.id)) {
    throw forbidden('এই ইউজারকে মেসেজ পাঠানো যাবে না (ব্লক)', 'blocked');
  }
  const toSettings = getSettings(to.id);
  if (toSettings.dm_privacy === 'nobody') throw forbidden('এই ইউজার কারও কাছ থেকে মেসেজ গ্রহণ করেন না', 'dm_private');
  if (toSettings.dm_privacy === 'following' &&
      !get('SELECT 1 FROM follows WHERE follower_id = ? AND target_id = ?', to.id, req.user.id)) {
    throw forbidden('শুধুমাত্র ফলোয়াররাই এই ইউজারকে মেসেজ পাঠাতে পারে', 'dm_private');
  }
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
  const period = req.query.period === 'week' ? 7 * 86_400_000
    : req.query.period === 'month' ? 30 * 86_400_000
    : 86_400_000;
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
     GROUP BY u.id ORDER BY spent DESC, u.level DESC LIMIT 20`, since);
  const topReceivers = all(
    `SELECT u.id, u.display_name, u.username, u.avatar, u.level, u.vip,
            COALESCE(SUM(g.coins), 0) received, COUNT(*) gifts
     FROM users u JOIN gift_events g ON g.to_id = u.id AND g.created_at > ?
     GROUP BY u.id ORDER BY received DESC LIMIT 20`, since);
  res.json({
    period: ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day',
    hosts: topHosts, givers: topGivers, receivers: topReceivers,
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
    app: config.brand.name,
    uptimeSec: Math.round(process.uptime()),
    version: require('../package.json').version,
    env: config.env,
    live: state.stats(),
    node: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    startedAt: process.__startedAt || null,
    features: {
      sms: !!config.otp.smsApiUrl,
      google: !!config.googleClientId,
      payments: config.payments.mode,
      turn: !!config.webrtc.turnUrl,
      push: push.configured(),
    },
  });
}));

module.exports = {
  router, publicProfile, notify, notifyPush, awardXp, getSettings, levelFromXp, xpForLevel,
  ROOM_CATEGORIES, THEMES, COIN_PACKAGES,
};
