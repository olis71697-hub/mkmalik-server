'use strict';

/**
 * Seed — creates the demo cast, gift catalog and a set of live rooms so the
 * Explore grid is never empty on a fresh deployment.
 *   node server/seed.js          (skips if data already exists)
 *   node server/seed.js --force  (wipes rooms/moments and re-seeds)
 */

const bcrypt = require('bcryptjs');
const config = require('./config');
const { all, get, run, db } = require('./db');
const { uid, svgAvatar, shortCode } = require('./util');
const state = require('./state');

const force = process.argv.includes('--force');

const PEOPLE = [
  ['mkmalik',  'MK Malik',    'male',   'IN', 42, 1, 1],
  ['aylin',    'Aylin ✨',    'female', 'TR', 31, 0, 0],
  ['rafi',     'Rafi Ahmed',  'male',   'BD', 27, 0, 0],
  ['sofia',    'Sofia Rose',  'female', 'ES', 24, 0, 0],
  ['kenji',    'Kenji',       'male',   'JP', 22, 0, 0],
  ['mira',     'Mira Khan',   'female', 'BD', 19, 0, 0],
  ['dani',     'Dani_777',    'male',   'AE', 17, 0, 0],
  ['luna',     'Luna 🎤',      'female', 'PH', 15, 0, 0],
  ['argon',    'Argon',       'male',   'DE', 13, 0, 0],
  ['priya',    'Priya S.',    'female', 'IN', 12, 0, 0],
  ['tariq',    'Tariq',       'male',   'PK', 10, 0, 0],
  ['hana',     'Hana Bloom',  'female', 'KR', 9,  0, 0],
  ['zayn',     'Zayn',        'male',   'EG', 8,  0, 0],
  ['elif',     'Elif',        'female', 'TR', 7,  0, 0],
  ['noah',     'Noah W.',     'male',   'US', 6,  0, 0],
  ['asha',     'Asha Rani',   'female', 'IN', 5,  0, 0],
  ['ilyas',    'Ilyas',       'male',   'BD', 4,  0, 0],
  ['nora',     'Nora',        'female', 'SE', 3,  0, 0],
  ['bilal',    'Bilal',       'male',   'SA', 2,  0, 0],
  ['chen',     'Chen Yu',     'male',   'CN', 1,  0, 0],
];

const GIFTS = [
  ['rose',      'Rose',        '🌹', 10,   'float', 1],
  ['heart',     'Heart',       '❤️', 20,   'float', 2],
  ['kiss',      'Kiss',        '💋', 50,   'float', 3],
  ['lollipop',  'Lollipop',    '🍭', 88,   'float', 4],
  ['coffee',    'Coffee',      '☕', 120,  'float', 5],
  ['beer',      'Cheers',      '🍺', 180,  'float', 6],
  ['cake',      'Birthday Cake','🎂', 299, 'float', 7],
  ['teddy',     'Teddy',       '🧸', 520,  'float', 8],
  ['rocket',    'Rocket',      '🚀', 888,  'launch', 9],
  ['crown',     'Golden Crown','👑', 1888, 'shine', 10],
  ['castle',    'Dream Castle','🏰', 3888, 'shine', 11],
  ['sports',    'Super Car',   '🏎️', 8888, 'launch', 12],
  ['galaxy',    'Galaxy',      '🌌', 18888,'shine', 13],
  ['dragon',    'Dragon',      '🐉', 32888,'epic', 14],
];

const ROOMS = [
  ['Share a happy thing😊',        'party',     'Tell us one good thing about today',  'gold',   ['newbie','friendly']],
  ['Welcome to our party🎉',       'party',     'Chill vibes only, grab a seat',        'rose',   ['party','chill']],
  ['I like singing a lot.',        'sing',      'Karaoke night — request a song',       'violet', ['music','karaoke']],
  ['Enjoy the party!!!',           'party',     'Non-stop music & games',               'sunset', ['games','music']],
  ['Midnight Music Room 🌙',       'music',     'Slow songs and deep talks',            'night',  ['lofi','calm']],
  ['Study with me 📚',             'study',     'Pomodoro 25/5 — mute & focus',         'mint',   ['focus','silent']],
  ['Squad up — ranked lobby',      'gaming',    'Duo queue, call your role',            'ocean',  ['valorant','fps']],
  ['Birthday Bash 🎂',             'birthday',  'Celebrating Mira today!',              'gold',   ['cake','surprise']],
  ['Stand-up & jokes 😂',          'comedy',    'Open mic comedy hour',                 'sunset', ['funny','openmic']],
  ['Dance floor 💃',               'dance',     'Drop your favourite track',            'rose',   ['edm','bolly']],
  ['Late Night Talk ☕',           'chat',      'Random talks, zero judgement',         'violet', ['talk','late']],
  ['Morning Broadcast 📻',         'broadcast', 'Daily news and shoutouts',             'ocean',  ['news','daily']],
  ['Adda time — Bangla 🇧🇩',      'chat',      'Bengali adda, sobe asho',              'mint',   ['bangla','adda']],
  ['Chill out zone 🫧',           'party',     'Music, mics open for all',             'night',  ['openmic','music']],
];

const TOPICS_CHAT = [
  'Kemon acho sobai? 😄', 'Welcome everyone 🎧', 'Play something romantic 🎵',
  'Mic ta open kore dao please 🙏', 'Adaab from Dhaka ✨', 'So sad the room is closing later',
  'Follow me, I follow back 💫', 'Who is singing next?', 'Send a gift to the host 🎁',
  'Anyone from Kolkata?', 'This song is 🔥', 'Good night all, love you 💙',
];

const MOMENT_TEXTS = [
  'First time hosting a full room — 10 mics taken in 4 minutes 🥳',
  'New mic setup is finally clean 🎙️ the sound is unbeatable',
  'Late night room was something else last night. Thank you all 💙',
  '3000 coins of roses in one song — you people are unreal 🌹',
  'Daily bonus claimed. Who wants to sing? 🎤',
  'Study room is at 24 people and completely silent 😂 perfect',
  'Chai + rainy evening + slow songs = perfect room ☕🌧️',
  'Just crossed level 30! Celebrating in my room tonight 🎂',
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
             DELETE FROM conversations; DELETE FROM notifications; DELETE FROM coin_ledger;`);
    db.exec(`DELETE FROM room_members; DELETE FROM rooms; DELETE FROM follows; DELETE FROM users;`);
  }

  // ---- people -------------------------------------------------------------
  const ids = {};
  const insertUser = db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar, bio, gender, country,
                        level, xp, coins, diamonds, vip, role, is_bot, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const pw = bcrypt.hashSync('demo1234', 10);
  PEOPLE.forEach(([username, name, gender, country, level, vip, isAdmin], i) => {
    const id = uid();
    ids[username] = id;
    const role = isAdmin ? 'admin' : (level >= 15 ? 'host' : 'user');
    insertUser.run(
      id, username, name, pw, svgAvatar(name, username), `Hi, I'm ${name}. Talk to me in my room! 🎙️`,
      gender, country, level, level * 120, 2000 + i * 350, i * 90, vip, role, 1,
      ago(60 * 24 * (PEOPLE.length - i)), Date.now() - i * 60_000);
  });
  db.exec('DELETE FROM users WHERE is_bot = 1 AND id NOT IN (SELECT id FROM users)');

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
    `INSERT INTO rooms (id, owner_id, title, topic, category, cover, language, theme, tags,
                        created_at, peak_users, total_joined, gift_coins)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insMember = db.prepare(
    `INSERT OR REPLACE INTO room_members (room_id, user_id, seat, is_muted, is_locked, hand_up, joined_at, last_seen)
     VALUES (?,?,?,?,?,?,?,?)`);

  const roomIds = [];
  ROOMS.forEach(([title, category, topic, theme, tags], ri) => {
    const hostUsername = names[(ri + 1) % names.length];
    const id = uid();
    roomIds.push(id);
    const hostId = ids[hostUsername];
    insRoom.run(id, hostId, title, topic, category, '', category === 'chat' ? 'bangla' : 'any',
      theme, JSON.stringify(tags), ago(5 + ri * 7), 0, 0, ri * 850);

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

    // recent chat
    for (let i = 0; i < 6; i++) {
      const speaker = rnd(names);
      run(`INSERT INTO room_messages (id, room_id, user_id, kind, body, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
        uid(), id, ids[speaker], 'text', rnd(TOPICS_CHAT), '{}', ago(60 - i * 6));
    }
    run(`INSERT INTO room_messages (id, room_id, user_id, kind, body, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
      uid(), id, null, 'system', 'The host opened the mic seats 🎙️', '{}', ago(58));
  });

  // ---- moments ------------------------------------------------------------
  const insMoment = db.prepare(
    `INSERT INTO moments (id, user_id, body, media, likes, comments, created_at) VALUES (?,?,?,?,?,?,?)`);
  PEOPLE.slice(0, 14).forEach(([username], i) => {
    insMoment.run(uid(), ids[username], MOMENT_TEXTS[i % MOMENT_TEXTS.length], null,
      Math.floor(Math.random() * 240), Math.floor(Math.random() * 30), ago(12 + i * 47));
  });

  // ---- a couple of direct conversations for the logged-in demo user -------
  const me = ids.mkmalik;
  ['aylin', 'rafi', 'sofia', 'mira'].forEach((u, i) => {
    const other = ids[u];
    const a = [me, other].sort();
    const convId = a.join('_');
    run('INSERT OR IGNORE INTO conversations (id, a_id, b_id, last_body, last_at) VALUES (?,?,?,?,?)',
      convId, a[0], a[1], '', 0);
    const lines = [
      'Hey! Are you hosting tonight? 🎤',
      'Yes! Room opens at 9 — come early for a mic seat 😄',
      'That party last night was amazing 🔥',
      'Join my room, we have 3 mics free right now',
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
  console.log('[seed] demo login →  username: mkmalik   password: demo1234');
  console.log('[seed] every seeded account uses password: demo1234');
}

if (require.main === module) seed();
module.exports = seed;
