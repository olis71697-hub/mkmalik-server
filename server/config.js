'use strict';

// ---------------------------------------------------------------------------
// Load .env (if present) before anything reads process.env
// ---------------------------------------------------------------------------
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',

  // Public base URL used when generating absolute links (invites, share cards).
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  // JWT -------------------------------------------------------------------
  jwtSecret: process.env.JWT_SECRET || (() => {
    // Stable per-deployment dev secret so sessions survive a restart.
    const fs = require('node:fs');
    const p = path.join(ROOT, 'data', '.jwt-secret');
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
      const s = crypto.randomBytes(48).toString('hex');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, s, { mode: 0o600 });
      return s;
    } catch (_) {
      return 'mkmalik-dev-secret-' + ROOT;
    }
  })(),
  jwtTtl: process.env.JWT_TTL || '30d',

  // Storage ---------------------------------------------------------------
  dataDir: process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : path.join(ROOT, 'data'),
  uploadDir: process.env.UPLOAD_DIR ? path.resolve(ROOT, process.env.UPLOAD_DIR) : path.join(ROOT, 'data', 'uploads'),
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 8) * 1024 * 1024,

  // Voice rooms -----------------------------------------------------------
  room: {
    micSeats: 10,            // exactly 10 mic seats, like Saada
    maxListeners: num(process.env.MAX_LISTENERS, 60),
    emptyRoomTtlMs: 1000 * 60 * 5,   // room closes 5 min after the last person leaves
    maxRoomsPerUser: 1,
  },

  // Coin economy (server authoritative — never trust the client) -----------
  economy: {
    welcomeCoins: num(process.env.WELCOME_COINS, 1500),
    seatMinCoins: 100,
    hostSharePct: 60,        // % of gift value credited to the host
    dailyBonus: 150,
  },

  // Abuse protection ------------------------------------------------------
  limits: {
    loginAttemptsPerMin: 12,
    msgsPer10s: 14,
    roomsCreatedPerHour: 6,
    giftsPer10s: 8,
    followPerMin: 30,
    momentsPerHour: 12,
    maxBioLen: 200,
    maxMsgLen: 500,
    maxRoomTitleLen: 60,
    minPasswordLen: 6,
  },

  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: bool(process.env.TRUST_PROXY, true),

  // WebRTC — STUN is always on; TURN relays media when both peers sit behind
  // symmetric NATs. Point these at your own coturn / hosted TURN to make voice
  // work reliably across mobile networks.
  webrtc: {
    stun: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
      .split(',').map((s) => s.trim()).filter(Boolean),
    turnUrl: process.env.TURN_URL || '',
    turnUsername: process.env.TURN_USERNAME || '',
    turnCredential: process.env.TURN_CREDENTIAL || '',
    // minutes; used by coturn REST / ephemeral credentials when TURN_SECRET is set
    turnSecret: process.env.TURN_SECRET || '',
  },
};

config.isProd = config.env === 'production';

module.exports = config;
