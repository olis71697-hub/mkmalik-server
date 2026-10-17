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

  // Brand -----------------------------------------------------------------
  brand: {
    name: 'Panda Voice',
    short: 'Panda',
    tagline: '১০ সিটের লাইভ ভয়েস রুম 🐼',
  },

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
      return 'panda-voice-dev-secret-' + ROOT;
    }
  })(),
  jwtTtl: process.env.JWT_TTL || '30d',

  // Storage ---------------------------------------------------------------
  dataDir: process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : path.join(ROOT, 'data'),
  uploadDir: process.env.UPLOAD_DIR ? path.resolve(ROOT, process.env.UPLOAD_DIR) : path.join(ROOT, 'data', 'uploads'),
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 8) * 1024 * 1024,

  // Voice rooms -----------------------------------------------------------
  room: {
    micSeats: 10,            // exactly 10 mic seats per room
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
    loginAttemptsPerMin: num(process.env.AUTH_ATTEMPTS_PER_MIN, 12),
    msgsPer10s: 14,
    roomsCreatedPerHour: num(process.env.ROOMS_PER_HOUR, 6),
    giftsPer10s: 8,
    followPerMin: 30,
    momentsPerHour: 12,
    reactionsPer10s: 12,
    maxBioLen: 200,
    maxMsgLen: 500,
    maxRoomTitleLen: 60,
    minPasswordLen: 6,
  },

  // Phone OTP login -------------------------------------------------------
  // With no SMS gateway configured the code is returned in the API response
  // (and printed in the server log) so the flow is fully testable. Set
  // SMS_API_URL (+ SMS_API_KEY) to deliver codes for real.
  otp: {
    ttlMs: 5 * 60 * 1000,
    length: 6,
    maxPerHour: num(process.env.OTP_PER_HOUR, 12),
    smsApiUrl: process.env.SMS_API_URL || '',
    smsApiKey: process.env.SMS_API_KEY || '',
    smsFrom: process.env.SMS_FROM || 'PandaVoice',
  },

  // Google Sign-In --------------------------------------------------------
  // Set GOOGLE_CLIENT_ID to the "Web client" OAuth ID from Google Cloud
  // Console. Until then the endpoint answers 503 with setup instructions.
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',

  // Wallet / coin purchases ------------------------------------------------
  // 'mock'  → simulated gateway: any payment ref like "MOCK-xxxx" is accepted
  //           once, credited once (idempotent), and clearly labelled in the UI.
  // 'live'  → point PURCHASE_VERIFY_URL at your real gateway's verification
  //           endpoint (SSLCommerz/bKash/Stripe etc.); the server then refuses
  //           to credit coins unless the gateway confirms the payment.
  payments: {
    mode: process.env.PAYMENTS_MODE || 'mock',
    verifyUrl: process.env.PURCHASE_VERIFY_URL || '',
    verifyKey: process.env.PURCHASE_VERIFY_KEY || '',
    currency: process.env.PAYMENT_CURRENCY || 'BDT',
  },

  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: bool(process.env.TRUST_PROXY, true),

  // When on, a visitor with no saved session is dropped straight into the demo
  // account instead of the sign-in screen — so the app is immediately usable
  // for evaluation. Turn off for a real public deployment.
  demoAutoLogin: bool(process.env.DEMO_AUTO_LOGIN, process.env.NODE_ENV !== 'production'),

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
