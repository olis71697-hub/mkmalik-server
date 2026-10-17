'use strict';

/**
 * DEV FIXTURE ONLY — never run automatically at boot.
 * Creates a cast of test users and rooms for local development:
 *   node server/seed.js          (skips if data already exists)
 *   node server/seed.js --force  (wipes rooms/moments and re-seeds)
 * Real deployments start empty and fill up with real sign-ups.
 */

const bcrypt = require('bcryptjs');
const config = require('./config');
const { all, get, run, db } = require('./db');
const { uid, svgAvatar, shortCode } = require('./util');
const state = require('./state');

const force = process.argv.includes('--force');

/** [username, display name, gender, country, level, vip, isAdmin] */
const PEOPLE = [
  ['panda',    'Panda Host 🐼', 'male',   'BD', 42, 1, 1],
  ['nusrat',   'Nusrat ✨',     'female', 'BD', 31, 0, 0],
  ['rafi',     'Rafi Ahmed',    'male',   'BD', 27, 0, 0],
  ['tuli',     'Tuli Roy',      'female', 'IN', 24, 1, 0],
  ['kenji',    'Kenji',         'male',   'JP', 22, 0, 0],
  ['mira',     'Mira Khan',     'female', 'BD', 19, 0, 0],
  ['dani',     'Dani_777',      'male',   'AE', 17, 0, 0],
  ['luna',     'Luna 🎤',       'female', 'PH', 15, 0, 0],
  ['argon',    'Argon',         'male',   'DE', 13, 0, 0],
  ['priya',    'Priya S.',      'female', 'IN', 12, 0, 0],
  ['tariq',    'Tariq',         'male',   'PK', 10, 0, 0],
  ['hana',     'Hana Bloom',    'female', 'KR', 9,  0, 0],
  ['zayn',     'Zayn',          'male',   'EG', 8,  0, 0],
  ['elif',     'Elif',          'female', 'TR', 7,  0, 0],
  ['noah',     'Noah W.',       'male',   'US', 6,  0, 0],
  ['asha',     'Asha Rani',     'female', 'IN', 5,  0, 0],
  ['ilyas',    'Ilyas',         'male',   'BD', 4,  0, 0],
  ['nora',     'Nora',          'female', 'SE', 3,  0, 0],
  ['bilal',    'Bilal',         'male',   'SA', 2,  0, 0],
  ['chen',     'Chen Yu',       'male',   'CN', 1,  0, 0],
];

/* The gift wall is product data shared with config.js — db.js bootstraps it. */
const GIFTS = config.GIFTS;

/** [title, category, topic, theme, tags] */
const ROOMS = [
  ['🐼 Panda Adda — সবাই আসো',        'chat',       'বাংলা আড্ডা, ১০টা মাইক খোলা',           'bamboo', ['bangla','adda']],
  ['Welcome to our party 🎉',           'party',      'Chill vibes only, grab a seat',        'gold',   ['party','chill']],
  ['আমি গান গাইতে ভালোবাসি 🎤',        'sing',       'Karaoke night — request a song',       'violet', ['music','karaoke']],
  ['Enjoy the party!!!',                'party',      'Non-stop music & games',               'sunset', ['games','music']],
  ['Midnight Music Room 🌙',            'music',      'Slow songs and deep talks',            'night',  ['lofi','calm']],
  ['Study with me 📚',                  'study',      'Pomodoro 25/5 — mute & focus',         'mint',   ['focus','silent']],
  ['Squad up — ranked lobby',           'gaming',     'Duo queue, call your role',            'ocean',  ['valorant','fps']],
  ['Birthday Bash 🎂',                  'birthday',   'Celebrating Mira today!',              'gold',   ['cake','surprise']],
  ['Stand-up & jokes 😂',               'comedy',     'Open mic comedy hour',                 'sunset', ['funny','openmic']],
  ['Dance floor 💃',                    'dance',      'Drop your favourite track',            'rose',   ['edm','bolly']],
  ['Late Night Talk ☕',                'chat',       'Random talks, zero judgement',         'violet', ['talk','late']],
  ['Morning Broadcast 📻',              'broadcast',  'Daily news and shoutouts',             'ocean',  ['news','daily']],
  ['নতুনদের রুম — Newbies 🐣',        'chat',       'প্রথমবার? চলে এসো, শিখে নাও',           'bamboo', ['newbie','friendly']],
  ['Chill out zone 🫧',                 'party',      'Music, mics open for all',             'night',  ['openmic','music']],
];

const TOPICS_CHAT = [
  'কেমন আছো সবাই? 😄', 'সবাইকে স্বাগতম 🎧', 'একটা রোমান্টিক গান বাজাও 🎵',
  'মাইকটা একটু খুলে দাও ভাই 🙏', 'ঢাকা থেকে কেউ আছে? ✨', 'আজকের রুমটা দারুণ যাচ্ছে',
  'Follow me, I follow back 💫', 'পরের গান কে গাইবে?', 'হোস্টকে গিফট পাঠাও 🎁',
  'কলকাতা থেকে কেউ? 🇮🇳', 'গানটা তো আগুন 🔥', 'শুভরাত্রি সবাইকে, ভালোবাসা 💚',
];

const MOMENT_TEXTS = [
  'প্রথমবার ফুল রুম হোস্ট করলাম — ৪ মিনিটে ১০টা মাইক শেষ 🥳',
  'নতুন মাইক সেটআপ ফাইনালি রেডি 🎙️ সাউন্ড অসাধারণ',
  'গতকালের লেট নাইট রুমটা অন্যরকম ছিল। সবাইকে ধন্যবাদ 💚',
  'একটা গানে ৩০০০ কয়েনের রোজ — তোমরা অবিশ্বাস্য 🌹',
  'ডেইলি বোনাস নিলাম। কে গাইবে? 🎤',
  'স্টাডি রুমে ২৪ জন এবং পুরো নীরব 😂 পারফেক্ট',
  'চা + বৃষ্টির সন্ধ্যা + স্লো গান = পারফেক্ট রুম ☕🌧️',
  'লেভেল ৩০ পার করলাম! আজ রাতে আমার রুমে সেলিব্রেশন 🎂',
];

const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const ago = (min) => Date.now() - min * 60_000;

function seed() {
  const existing = get('SELECT COUNT(*) c FROM users').c;
  if (existing > 0 && !force) {
    console.log(`[seed] database already has ${existing} users — nothing to do (use --force to reset)`);
    return;
  }

  if (force) {
    console.log('[seed] --force: clearing live data…');
    for (const r of state.liveRooms()) state.closeRoom(r.id, 'reset');
    db.exec(`DELETE FROM room_messages; DELETE FROM gift_events; DELETE FROM moment_likes;
             DELETE FROM moment_comments; DELETE FROM moments; DELETE FROM messages;
             DELETE FROM conversations; DELETE FROM notifications; DELETE FROM coin_ledger;
             DELETE FROM mod_log; DELETE FROM room_bans; DELETE FROM room_mods; DELETE FROM reports;
             DELETE FROM purchases; DELETE FROM otp_codes;`);
    db.exec(`DELETE FROM room_members; DELETE FROM rooms; DELETE FROM follows; DELETE FROM blocks; DELETE FROM user_settings; DELETE FROM users;`);
  }

  // ---- people -------------------------------------------------------------
  const ids = {};
  const insertUser = db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar, bio, gender, country,
                        level, xp, coins, diamonds, vip, role, is_bot, user_code, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const pw = bcrypt.hashSync('demo1234', 10);
  PEOPLE.forEach(([username, name, gender, country, level, vip, isAdmin], i) => {
    const id = uid();
    ids[username] = id;
    const role = isAdmin ? 'admin' : (level >= 15 ? 'host' : 'user');
    const code = String(100001 + i);
    insertUser.run(
      id, username, name, pw, svgAvatar(name, username), `হাই, আমি ${name} — আমার রুমে কথা বলো! 🐼🎙️`,
      gender, country, level, level * 120, 2000 + i * 350, i * 90, vip, role, 1,
      code, ago(60 * 24 * (PEOPLE.length - i)), Date.now() - i * 60_000);
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, language, theme, updated_at) VALUES (?,?,?,?)')
      .run(id, 'bn', 'dark', Date.now());
  });

  // ---- gifts --------------------------------------------------------------
  const insGift = db.prepare('INSERT OR REPLACE INTO gift_catalog (id, name, emoji, price, anim, sort) VALUES (?,?,?,?,?,?)');
  GIFTS.forEach(([id, name, emoji, price, anim, sort]) => insGift.run(id, name, emoji, price, anim, sort));

  // ---- follows ------------------------------------------------------------
  const insFollow = db.prepare('INSERT OR IGNORE INTO follows (follower_id, target_id, created_at) VALUES (?,?,?)');
  const names = PEOPLE.map((p) => p[0]);
  for (const a of names) for (const b of names) {
    if (a !== b && Math.random() < 0.35) insFollow.run(ids[a], ids[b], ago(60 * 24 * 10));
  }

  // ---- live rooms ---------------------------------------------------------
  const insRoom = db.prepare(
    `INSERT INTO rooms (id, owner_id, title, topic, category, cover, language, theme, tags, rules,
                        created_at, peak_users, total_joined, gift_coins)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insMember = db.prepare(
    `INSERT OR REPLACE INTO room_members (room_id, user_id, seat, is_muted, is_locked, hand_up, joined_at, last_seen)
     VALUES (?,?,?,?,?,?,?,?)`);
  const RULES = '১. সবার সাথে সম্মানের সাথে কথা বলুন  ২. একসাথে কথা না বলে পালা করে বলুন  ৩. স্প্যাম করবেন না 🐼';

  const roomIds = [];
  ROOMS.forEach(([title, category, topic, theme, tags], ri) => {
    const hostUsername = names[(ri + 1) % names.length];
    const id = uid();
    roomIds.push(id);
    const hostId = ids[hostUsername];
    const lang = /[\u0980-\u09FF]/.test(title) || category === 'chat' ? 'bn' : 'any';
    insRoom.run(id, hostId, title, topic, category, '', lang, theme, JSON.stringify(tags), RULES,
      ago(5 + ri * 7), 0, 0, ri * 850);

    // fill some seats + listeners so the grid shows real numbers
    const speakers = 1 + Math.floor(Math.random() * 5);      // 1..5 on mic
    const listeners = Math.floor(Math.random() * 14);
    const guests = names.filter((n) => n !== hostUsername).sort(() => Math.random() - 0.5);

    insMember.run(id, hostId, 0, 0, 0, 0, ago(40 + ri), Date.now());
    let seat = 1;
    for (let i = 0; i < speakers && seat < state.SEATS; i++, seat++) {
      insMember.run(id, ids[guests[i]], seat, Math.random() < 0.4 ? 1 : 0, 0, 0, ago(30 - i), Date.now());
    }
    for (let i = 0; i < listeners; i++) {
      const g = guests[(speakers + i) % guests.length];
      insMember.run(id, ids[g], null, 1, 0, Math.random() < 0.2 ? 1 : 0, ago(20 - (i % 18)), Date.now());
    }

    // a moderator for the host
    db.prepare('INSERT OR IGNORE INTO room_mods (room_id, user_id, added_by, created_at) VALUES (?,?,?,?)')
      .run(id, ids[guests[speakers + 1] || guests[0]], hostId, ago(35));

    // recent chat
    for (let i = 0; i < 6; i++) {
      const speaker = rnd(names);
      run(`INSERT INTO room_messages (id, room_id, user_id, kind, body, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
        uid(), id, ids[speaker], 'text', rnd(TOPICS_CHAT), '{}', ago(60 - i * 6));
    }
    run(`INSERT INTO room_messages (id, room_id, user_id, kind, body, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
      uid(), id, null, 'system', 'হোস্ট মাইক সিটগুলো খুলে দিল 🎙️', '{}', ago(58));
  });

  // ---- gift history (so profiles + leaderboards look alive) ----------------
  const insGiftEvent = db.prepare(
    `INSERT INTO gift_events (id, room_id, from_id, to_id, gift_id, qty, coins, created_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 60; i++) {
    const from = rnd(names), to = rnd(names);
    if (from === to) continue;
    const g = rnd(GIFTS);
    insGiftEvent.run(uid(), rnd(roomIds), ids[from], ids[to], g[0], 1, g[3], ago(Math.random() * 60 * 24 * 3));
  }

  // ---- moments --------------------------------------------------------------
  const insMoment = db.prepare(
    `INSERT INTO moments (id, user_id, body, media, likes, comments, created_at) VALUES (?,?,?,?,?,?,?)`);
  PEOPLE.slice(0, 14).forEach(([username], i) => {
    insMoment.run(uid(), ids[username], MOMENT_TEXTS[i % MOMENT_TEXTS.length], null,
      Math.floor(Math.random() * 240), Math.floor(Math.random() * 30), ago(12 + i * 47));
  });

  // ---- a couple of direct conversations for the demo user -------------------
  const me = ids.panda;
  ['nusrat', 'rafi', 'tuli', 'mira'].forEach((u, i) => {
    const other = ids[u];
    const a = [me, other].sort();
    const convId = a.join('_');
    run('INSERT OR IGNORE INTO conversations (id, a_id, b_id, last_body, last_at) VALUES (?,?,?,?,?)',
      convId, a[0], a[1], '', 0);
    const lines = [
      'হাই! আজ রাতে রুম করবে? 🎤',
      'হ্যাঁ! ৯টায় রুম খুলব — আগে এসো, সিট পেয়ে যাবে 😄',
      'গতকালের পার্টিটা অসাধারণ ছিল 🔥',
      'আমার রুমে আসো, ৩টা মাইক খালি আছে',
    ];
    for (let k = 0; k < 3; k++) {
      const fromMe = k % 2 === 0;
      const t = ago(180 - i * 20 - k * 3);
      run('INSERT INTO messages (id, conv_id, from_id, to_id, body, kind, read_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
        uid(), convId, fromMe ? me : other, fromMe ? other : me, lines[(i + k) % lines.length], 'text', t, t);
    }
    const body = lines[(i + 2) % lines.length];
    const unreadCol = a[0] === me ? 'a_unread' : 'b_unread';
    run(`UPDATE conversations SET last_body = ?, last_at = ?, ${unreadCol} = ? WHERE id = ?`,
      body, ago(170 - i * 20), i % 3, convId);
  });

  const counts = {
    users: get('SELECT COUNT(*) c FROM users').c,
    rooms: get('SELECT COUNT(*) c FROM rooms WHERE closed_at IS NULL').c,
    gifts: get('SELECT COUNT(*) c FROM gift_catalog').c,
    moments: get('SELECT COUNT(*) c FROM moments').c,
  };
  console.log('[seed] done', counts);
  console.log('[seed] demo login →  username: panda   password: demo1234');
  console.log('[seed] every seeded account uses password: demo1234');
}

if (require.main === module) seed();
module.exports = seed;
