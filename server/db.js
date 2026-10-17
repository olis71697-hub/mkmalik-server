'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'panda-voice.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');

// ---------------------------------------------------------------------------
// Schema — idempotent, applied on every boot
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar        TEXT,
  bio           TEXT DEFAULT '',
  gender        TEXT DEFAULT 'any',
  country       TEXT DEFAULT '',
  phone         TEXT,
  email         TEXT,
  google_id     TEXT UNIQUE,
  user_code     TEXT,
  level         INTEGER DEFAULT 1,
  xp            INTEGER DEFAULT 0,
  coins         INTEGER DEFAULT 0,
  diamonds      INTEGER DEFAULT 0,
  vip           INTEGER DEFAULT 0,
  role          TEXT DEFAULT 'user',           -- user | host | admin
  is_bot        INTEGER DEFAULT 0,
  last_bonus_at INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_seen ON users(last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_code ON users(user_code) WHERE user_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language    TEXT DEFAULT 'bn',
  theme       TEXT DEFAULT 'dark',
  notify_follow   INTEGER DEFAULT 1,
  notify_message  INTEGER DEFAULT 1,
  notify_gift     INTEGER DEFAULT 1,
  notify_invite   INTEGER DEFAULT 1,
  dm_privacy      TEXT DEFAULT 'everyone',     -- everyone | following | nobody
  show_online     INTEGER DEFAULT 1,
  updated_at  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, target_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, target_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type  TEXT NOT NULL,                 -- user | room
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  note         TEXT DEFAULT '',
  status       TEXT DEFAULT 'open',           -- open | reviewed | dismissed
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports ON reports(status, created_at DESC);

CREATE TABLE IF NOT EXISTS rooms (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  topic        TEXT DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'party',
  cover        TEXT,
  language     TEXT DEFAULT 'any',
  pin_code     TEXT,
  locked       INTEGER DEFAULT 0,
  is_private   INTEGER DEFAULT 0,
  theme        TEXT DEFAULT 'bamboo',
  tags         TEXT DEFAULT '[]',
  rules        TEXT DEFAULT '',
  chat_open    INTEGER DEFAULT 1,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  ended_reason TEXT,
  peak_users   INTEGER DEFAULT 0,
  total_joined INTEGER DEFAULT 0,
  gift_coins   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rooms_open ON rooms(closed_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_cat ON rooms(category, closed_at);

CREATE TABLE IF NOT EXISTS room_members (
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seat       INTEGER,                          -- NULL = listener
  is_muted   INTEGER DEFAULT 1,
  is_locked  INTEGER DEFAULT 0,                -- seat lock (owner-managed "invite only")
  hand_up    INTEGER DEFAULT 0,
  joined_at  INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_bans (
  room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  by_id     TEXT,
  reason    TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_mods (
  room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by  TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS mod_log (
  id         TEXT PRIMARY KEY,
  room_id    TEXT,
  actor_id   TEXT,
  target_id  TEXT,
  action     TEXT NOT NULL,                   -- kick | ban | mute | mod_add | mod_remove | lock | unlock
  note       TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modlog ON mod_log(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS room_messages (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT DEFAULT 'text',              -- text | system | gift | join | leave
  body       TEXT DEFAULT '',
  meta       TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_msg ON room_messages(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gift_catalog (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  emoji     TEXT NOT NULL,
  price     INTEGER NOT NULL,
  anim      TEXT DEFAULT 'float',
  sort      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gift_events (
  id         TEXT PRIMARY KEY,
  room_id    TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  from_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  gift_id    TEXT NOT NULL,
  qty        INTEGER DEFAULT 1,
  coins      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gift_to ON gift_events(to_id, created_at DESC);

CREATE TABLE IF NOT EXISTS moments (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT DEFAULT '',
  media      TEXT,                              -- /uploads/xxx.jpg
  room_id    TEXT,
  likes      INTEGER DEFAULT 0,
  comments   INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moments ON moments(created_at DESC);

CREATE TABLE IF NOT EXISTS moment_likes (
  moment_id  TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (moment_id, user_id)
);

CREATE TABLE IF NOT EXISTS moment_comments (
  id         TEXT PRIMARY KEY,
  moment_id  TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mc ON moment_comments(moment_id, created_at);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  a_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_body   TEXT DEFAULT '',
  last_at     INTEGER DEFAULT 0,
  a_unread    INTEGER DEFAULT 0,
  b_unread    INTEGER DEFAULT 0,
  UNIQUE (a_id, b_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id      TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body    TEXT NOT NULL,
  kind    TEXT DEFAULT 'text',
  read_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT DEFAULT '',
  body       TEXT DEFAULT '',
  meta       TEXT DEFAULT '{}',
  seen       INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coin_ledger (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  meta       TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger ON coin_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchases (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id    TEXT NOT NULL,
  coins         INTEGER NOT NULL,
  price         TEXT NOT NULL,
  currency      TEXT DEFAULT 'BDT',
  payment_ref   TEXT NOT NULL,
  payment_method TEXT DEFAULT 'unspecified',
  status        TEXT DEFAULT 'pending',        -- pending | success | failed | refunded
  created_at    INTEGER NOT NULL,
  UNIQUE (payment_ref)
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id         TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  code       TEXT NOT NULL,
  purpose    TEXT DEFAULT 'login',
  attempts   INTEGER DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp ON otp_codes(phone, created_at DESC);

-- Web Push (VAPID) subscriptions for Android / desktop notifications
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`);

// ---------------------------------------------------------------------------
// The gift catalog is product data, not seed data — a fresh database always
// has the full gift wall, with or without `npm run seed`.
// ---------------------------------------------------------------------------
try {
  const { GIFTS } = require('./config');
  const insGift = db.prepare('INSERT OR IGNORE INTO gift_catalog (id, name, emoji, price, anim, sort) VALUES (?,?,?,?,?,?)');
  for (const g of GIFTS) insGift.run(...g);
} catch (e) { console.error('[db] gift catalog bootstrap failed:', e.message); }

// ---------------------------------------------------------------------------
// Migrations for databases created by the previous ("mkmalik") schema
// ---------------------------------------------------------------------------
for (const col of [
  ['users', 'phone', 'TEXT'],
  ['users', 'email', 'TEXT'],
  ['users', 'google_id', 'TEXT'],
  ['users', 'user_code', 'TEXT'],
  ['rooms', 'rules', "TEXT DEFAULT ''"],
  ['rooms', 'chat_open', 'INTEGER DEFAULT 1'],
]) {
  try { db.exec(`ALTER TABLE ${col[0]} ADD COLUMN ${col[1]} ${col[2]}`); } catch (_) { /* already there */ }
}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL`); } catch (_) {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_code ON users(user_code) WHERE user_code IS NOT NULL`); } catch (_) {}

// Backfill short numeric user codes for pre-existing accounts.
try {
  const missing = all('SELECT id FROM users WHERE user_code IS NULL');
  for (const u of missing) {
    let code = String(100000 + Math.floor(Math.random() * 900000));
    for (let tries = 0; tries < 20; tries++) {
      const taken = get('SELECT 1 FROM users WHERE user_code = ?', code);
      if (!taken) break;
      code = String(100000 + Math.floor(Math.random() * 900000));
    }
    run('UPDATE users SET user_code = ? WHERE id = ?', code, u.id);
  }
} catch (_) { /* non-fatal */ }

// ---------------------------------------------------------------------------
// Thin query helpers
// ---------------------------------------------------------------------------
const cache = new Map();
function prep(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const all = (sql, ...p) => prep(sql).all(...p);
const get = (sql, ...p) => prep(sql).get(...p);
const run = (sql, ...p) => prep(sql).run(...p);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

const now = () => Date.now();
const uid = () => require('node:crypto').randomUUID().replace(/-/g, '').slice(0, 20);

module.exports = { db, all, get, run, tx, now, uid };
