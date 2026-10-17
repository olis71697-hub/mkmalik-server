'use strict';

const crypto = require('node:crypto');
const config = require('./config');

// --- ids -------------------------------------------------------------------
const uid = (n = 20) => crypto.randomBytes(24).toString('base64url').slice(0, n);
const shortCode = (len = 6) => {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
};

// --- time ------------------------------------------------------------------
const now = () => Date.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// --- validation ------------------------------------------------------------
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\u200d\uFE0F\s]+$/u;

function badRequest(msg, code = 'bad_request') {
  const e = new Error(msg);
  e.status = 400;
  e.code = code;
  return e;
}
function unauthorized(msg = 'Not signed in') {
  const e = new Error(msg);
  e.status = 401;
  e.code = 'unauthorized';
  return e;
}
function notFound(msg = 'Not found') {
  const e = new Error(msg);
  e.status = 404;
  e.code = 'not_found';
  return e;
}
function forbidden(msg = 'Not allowed', code = 'forbidden') {
  const e = new Error(msg);
  e.status = 403;
  e.code = code;
  return e;
}

function cleanText(input, max, label = 'text') {
  if (typeof input !== 'string') throw badRequest(`${label} must be text`);
  // strip control chars except newline/tab, collapse long runs
  let s = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\n{4,}/g, '\n\n').trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function assertUsername(u) {
  if (typeof u !== 'string' || !USERNAME_RE.test(u)) {
    throw badRequest('Username must be 3-20 characters: letters, numbers, dot or underscore');
  }
  return u;
}

function assertPassword(p) {
  if (typeof p !== 'string' || p.length < config.limits.minPasswordLen) {
    throw badRequest(`Password must be at least ${config.limits.minPasswordLen} characters`);
  }
  if (p.length > 200) throw badRequest('Password too long');
  return p;
}

// --- rate limiting (in-process token bucket, keyed) ------------------------
function makeLimiter(name, perWindow, windowMs, store = new Map()) {
  return {
    name,
    hit(key, cost = 1) {
      const k = `${name}:${key}`;
      const t = now();
      let rec = store.get(k);
      if (!rec || t - rec.start >= windowMs) { rec = { start: t, count: 0 }; store.set(k, rec); }
      rec.count += cost;
      if (rec.count > perWindow) {
        const retry = Math.ceil((windowMs - (t - rec.start)) / 1000);
        const e = new Error(`Too many requests — try again in ${retry}s`);
        e.status = 429;
        e.code = 'rate_limited';
        e.retryAfter = retry;
        throw e;
      }
      return true;
    },
    sweep() {
      const t = now();
      for (const [k, rec] of store) if (t - rec.start > windowMs * 2) store.delete(k);
    },
  };
}

// periodic sweep so the maps never grow unbounded
const limiters = [];
function limiter(name, perWindow, windowMs) {
  const l = makeLimiter(name, perWindow, windowMs);
  limiters.push(l);
  return l;
}
setInterval(() => limiters.forEach((l) => l.sweep()), 60_000).unref();

// --- avatars / covers ------------------------------------------------------
const AVATAR_GRADIENTS = [
  ['#ff8a3d', '#ff2d78'], ['#7b5cff', '#25d0ff'], ['#22c55e', '#0ea5e9'],
  ['#f43f5e', '#f59e0b'], ['#8b5cf6', '#ec4899'], ['#06b6d4', '#3b82f6'],
  ['#f97316', '#eab308'], ['#14b8a6', '#84cc16'],
];
function gradientFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}
function svgAvatar(name, seed) {
  const [a, b] = gradientFor(seed || name || 'x');
  const initials = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
      </linearGradient></defs>
      <rect width="160" height="160" fill="url(#g)"/>
      <text x="80" y="104" font-family="Segoe UI,Roboto,Helvetica,sans-serif" font-size="72"
        font-weight="700" fill="rgba(255,255,255,.92)" text-anchor="middle">${initials}</text>
    </svg>`);
}

// --- misc ------------------------------------------------------------------
function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch (_) { return fallback; }
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

module.exports = {
  uid, shortCode, now, clamp, badRequest, unauthorized, notFound, forbidden,
  cleanText, assertUsername, assertPassword, limiter, safeJson, svgAvatar,
  gradientFor, pick, EMOJI_ONLY_RE,
};
