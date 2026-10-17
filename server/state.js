'use strict';

/**
 * Live room state — the heart of the voice platform.
 *
 * The database is the durable record; this module holds the authoritative
 * in-memory view of every open room: who is on which of the 10 mic seats,
 * who is listening, mute states, raised hands and heartbeat timestamps.
 *
 * Everything that mutates a room goes through here so that the DB row, the
 * in-memory state and the broadcast payload can never drift apart.
 */

const config = require('./config');
const { all, get, run, now } = require('./db');
const { uid, badRequest, forbidden, notFound, safeJson } = require('./util');

const SEATS = config.room.micSeats; // 10

/** roomId -> Room */
const rooms = new Map();

const GUEST_TTL_MS = 45_000; // a member with no heartbeat for this long is dropped

function dbRoomToState(row) {
  const room = {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    topic: row.topic || '',
    category: row.category,
    cover: row.cover || '',
    language: row.language || 'any',
    locked: !!row.locked,
    isPrivate: !!row.is_private,
    theme: row.theme || 'bamboo',
    tags: safeJson(row.tags, []),
    rules: row.rules || '',
    chatOpen: row.chat_open === null ? true : !!row.chat_open,
    createdAt: row.created_at,
    pinCode: row.pin_code || null,
    peakUsers: row.peak_users || 0,
    totalJoined: row.total_joined || 0,
    giftCoins: row.gift_coins || 0,
    // live bits
    members: new Map(),     // userId -> member
    seats: new Array(SEATS).fill(null), // index -> userId
    lockedSeats: new Set(), // seats the host locked while empty
    mods: new Set(),        // moderators (host is implicit)
    bans: new Set(),        // banned user ids
    messages: [],           // recent ring buffer
    closedAt: null,
    emptySince: null,
  };
  for (const m of all('SELECT user_id FROM room_mods WHERE room_id = ?', row.id)) room.mods.add(m.user_id);
  for (const b of all('SELECT user_id FROM room_bans WHERE room_id = ?', row.id)) room.bans.add(b.user_id);
  return room;
}

function loadRoom(roomId) {
  let room = rooms.get(roomId);
  if (room) return room;
  const row = get('SELECT * FROM rooms WHERE id = ? AND closed_at IS NULL', roomId);
  if (!row) return null;
  room = dbRoomToState(row);
  // Rehydrate members that were in the room when the process last ran.
  for (const m of all('SELECT * FROM room_members WHERE room_id = ?', roomId)) {
    if (m.seat !== null && m.seat >= 0 && m.seat < SEATS && !room.seats[m.seat]) {
      room.members.set(m.user_id, memberFromRow(m));
      room.seats[m.seat] = m.user_id;
    }
  }
  rooms.set(roomId, room);
  if (isOfficialRoom(room)) respawnOfficialMembers(room);
  return room;
}

function memberFromRow(m) {
  return {
    userId: m.user_id, seat: m.seat, isMuted: !!m.is_muted, isLocked: !!m.is_locked,
    handUp: !!m.hand_up, joinedAt: m.joined_at, lastSeen: m.last_seen,
    speaking: false, user: get('SELECT * FROM users WHERE id = ?', m.user_id) || null,
  };
}

const publicUser = (u) => u ? {
  id: u.id, username: u.username, displayName: u.display_name,
  avatar: u.avatar, level: u.level, vip: !!u.vip, role: u.role,
  userCode: u.user_code || null,
  bio: u.bio || '', isBot: !!u.is_bot, coins: u.coins, diamonds: u.diamonds,
} : null;

function publicMember(m) {
  return {
    userId: m.userId, seat: m.seat, isMuted: m.isMuted, isLocked: m.isLocked,
    handUp: m.handUp, speaking: m.speaking, joinedAt: m.joinedAt, user: publicUser(m.user),
  };
}

/** Full snapshot of a room for the client. */
function snapshot(room, viewerId) {
  const members = [...room.members.values()].sort((a, b) => (a.joinedAt - b.joinedAt));
  return {
    id: room.id, ownerId: room.ownerId, title: room.title, topic: room.topic,
    category: room.category, cover: room.cover, language: room.language,
    locked: room.locked, isPrivate: room.isPrivate, theme: room.theme,
    tags: room.tags, createdAt: room.createdAt, pinRequired: !!room.pinCode,
    rules: room.rules || '', chatOpen: room.chatOpen !== false,
    mods: [...room.mods],
    seatCount: SEATS,
    seats: room.seats.map((id) => {
      if (!id) return null;
      const m = room.members.get(id);
      return m ? publicMember(m) : null;
    }),
    speakers: members.filter((m) => m.seat !== null).length,
    listeners: members.filter((m) => m.seat === null).length,
    members: members.map(publicMember),
    messages: room.messages.slice(-60),
    giftCoins: room.giftCoins,
    viewer: viewerId && room.members.has(viewerId) ? publicMember(room.members.get(viewerId)) : null,
    isOwner: viewerId === room.ownerId,
    isMod: viewerId === room.ownerId || (viewerId && room.mods.has(viewerId)),
  };
}

/** Lightweight card used by the Explore grid. */
function card(room) {
  const live = [...room.members.values()];
  const occupied = room.seats.filter(Boolean).length;
  const online = live.filter((m) => Date.now() - m.lastSeen < GUEST_TTL_MS).length;
  const hostMember = room.members.get(room.ownerId);
  const hostUser = hostMember ? hostMember.user : get('SELECT * FROM users WHERE id = ?', room.ownerId);
  // Face pile: speakers first, then listeners — whatever the grid needs.
  const recentUsers = live
    .slice()
    .sort((a, b) => (b.seat !== null) - (a.seat !== null) || b.joinedAt - a.joinedAt)
    .slice(0, 4)
    .map((m) => publicUser(m.user))
    .filter(Boolean);
  return {
    id: room.id, title: room.title, topic: room.topic, category: room.category,
    cover: room.cover, theme: room.theme, tags: room.tags,
    locked: room.locked, isPrivate: room.isPrivate, language: room.language,
    host: publicUser(hostUser),
    recentUsers,
    seatsTotal: SEATS, seatsTaken: occupied, seatsFree: SEATS - occupied,
    listeners: live.filter((m) => m.seat === null).length,
    online, hot: online,
    createdAt: room.createdAt,
    giftCoins: room.giftCoins,
    pinned: room.theme === 'gold' && occupied >= 3,
  };
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

function ensureSeatAvailable(room, preferSeat) {
  if (preferSeat !== undefined && preferSeat !== null) {
    const i = Number(preferSeat);
    if (!Number.isInteger(i) || i < 0 || i >= SEATS) throw badRequest('Seat out of range');
    if (room.seats[i]) throw badRequest('That seat is already taken');
    if (room.members.get(room.ownerId)?.isLocked && room.ownerId !== null) { /* owner may still lock */ }
    return i;
  }
  const free = room.seats.findIndex((s) => !s);
  if (free === -1) throw badRequest('All 10 mic seats are full — join as a listener');
  return free;
}

function isSeatLocked(room, index) {
  const occupantId = room.seats[index];
  if (!occupantId) {
    // A locked empty seat is stored on the room as `lockedSeats`
    return !!(room.lockedSeats && room.lockedSeats.has(index));
  }
  const m = room.members.get(occupantId);
  return !!(m && m.isLocked);
}

/**
 * A user joins a room. Guests land as listeners; takeSeat() promotes them.
 */
function join(roomId, user, opts = {}) {
  const room = loadRoom(roomId);
  if (!room) throw notFound('Room not found or already closed');

  if (room.bans.has(user.id) && user.role !== 'admin') {
    throw forbidden('আপনি এই রুম থেকে ব্যান হয়ে আছেন', 'room_banned');
  }
  if (room.isPrivate && room.pinCode && opts.pin !== room.pinCode && user.id !== room.ownerId && user.role !== 'admin') {
    throw forbidden('Wrong room password');
  }
  if (room.locked && user.id !== room.ownerId && user.role !== 'admin' && !room.mods.has(user.id)) {
    throw forbidden('This room is locked by the host');
  }

  const listeners = [...room.members.values()].filter((m) => m.seat === null).length;
  const existing = room.members.get(user.id);
  if (!existing && listeners >= config.room.maxListeners) {
    throw forbidden('Room is full — try another room');
  }

  const t = Date.now();
  const wantSeat = opts.seat !== undefined && opts.seat !== null && opts.seat !== false;
  let seat = existing ? existing.seat : null;
  if (wantSeat && seat === null) seat = ensureSeatAvailable(room, opts.seat === true ? null : opts.seat);

  const member = existing || {
    userId: user.id, seat: null, isMuted: true, isLocked: false, handUp: false,
    joinedAt: t, lastSeen: t, speaking: false, user,
  };
  member.user = user;
  member.lastSeen = t;
  member.seat = seat;
  room.members.set(user.id, member);

  // reflect seat map
  room.seats = room.seats.map((id) => (id === user.id ? null : id));
  if (seat !== null) room.seats[seat] = user.id;

  run(`INSERT INTO room_members (room_id, user_id, seat, is_muted, is_locked, hand_up, joined_at, last_seen)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(room_id, user_id) DO UPDATE SET seat=excluded.seat, is_muted=excluded.is_muted,
         hand_up=excluded.hand_up, last_seen=excluded.last_seen`,
    room.id, user.id, seat, member.isMuted ? 1 : 0, member.isLocked ? 1 : 0, member.handUp ? 1 : 0, member.joinedAt, t);

  room.emptySince = null;
  if (!existing) {
    run('UPDATE rooms SET total_joined = total_joined + 1 WHERE id = ?', room.id);
    room.totalJoined++;
  }
  return { room, member, wasAlreadyIn: !!existing };
}

function takeSeat(roomId, user, index) {
  const room = loadRoom(roomId);
  if (!room) throw notFound('Room is closed');
  const member = room.members.get(user.id);
  if (!member) throw forbidden('Join the room first');
  if (member.seat !== null) throw badRequest('You are already on a mic seat');

  const i = ensureSeatAvailable(room, index);
  if (isSeatLocked(room, i) && user.id !== room.ownerId) throw forbidden('That seat is locked');

  member.seat = i;
  member.isMuted = true;
  member.handUp = false;
  room.seats[i] = user.id;
  run('UPDATE room_members SET seat=?, is_muted=1, hand_up=0 WHERE room_id=? AND user_id=?', i, room.id, user.id);
  return { room, member, seat: i };
}

function leaveSeat(roomId, user) {
  const room = loadRoom(roomId);
  if (!room) return null;
  const member = room.members.get(user.id);
  if (!member || member.seat === null) return { room, member };
  const i = member.seat;
  room.seats[i] = null;
  member.seat = null;
  member.isMuted = true;
  run('UPDATE room_members SET seat=NULL, is_muted=1 WHERE room_id=? AND user_id=?', room.id, user.id);
  // promote the first raised hand
  const next = [...room.members.values()]
    .filter((m) => m.seat === null && m.handUp)
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];
  let promoted = null;
  if (next) {
    next.seat = i; next.handUp = false;
    room.seats[i] = next.userId;
    run('UPDATE room_members SET seat=?, hand_up=0 WHERE room_id=? AND user_id=?', i, room.id, next.userId);
    promoted = next;
  }
  return { room, seat: i, freedBy: user.id, promoted, member };
}

function setMute(roomId, user, muted) {
  const room = loadRoom(roomId);
  if (!room) throw notFound('Room is closed');
  const member = room.members.get(user.id);
  if (!member) throw forbidden('Join the room first');
  if (member.seat === null) throw badRequest('Only users on a mic seat can toggle the mic');
  member.isMuted = !!muted;
  run('UPDATE room_members SET is_muted=? WHERE room_id=? AND user_id=?', member.isMuted ? 1 : 0, room.id, user.id);
  return { room, member };
}

/** host, appointed moderators and admins can manage a room */
function canModerate(room, user) {
  return user && (user.id === room.ownerId || user.role === 'admin' || room.mods.has(user.id));
}

function kickFromSeat(roomId, actor, targetId, ban) {
  const room = loadRoom(roomId);
  if (!room) throw notFound('Room is closed');
  if (!canModerate(room, actor)) throw forbidden('শুধু হোস্ট বা মডারেটর এটি করতে পারে');
  const target = room.members.get(targetId);
  if (!target) throw notFound('That user is not in the room');
  if (target.userId === room.ownerId) throw badRequest('The host cannot be removed');
  if (room.mods.has(target.userId) && actor.id !== room.ownerId && actor.role !== 'admin') {
    throw forbidden('একজন মডারেটর অন্য মডারেটরকে সরাতে পারবেন না');
  }
  if (target.seat === null) throw badRequest('That user is not on a mic seat');
  room.seats[target.seat] = null;
  target.seat = null;
  target.isMuted = true;
  run('UPDATE room_members SET seat=NULL, is_muted=1 WHERE room_id=? AND user_id=?', room.id, targetId);
  if (ban) {
    room.bans.add(targetId);
    run('INSERT OR IGNORE INTO room_bans (room_id, user_id, by_id, reason, created_at) VALUES (?,?,?,?,?)',
      room.id, targetId, actor.id, 'banned by moderator', Date.now());
  }
  return { room, target };
}

/** Host/moderator force-mutes another seated user. */
function setMuteOther(roomId, actor, targetId, muted) {
  const room = loadRoom(roomId);
  if (!room) throw notFound('Room is closed');
  if (!canModerate(room, actor)) throw forbidden('শুধু হোস্ট বা মডারেটর এটি করতে পারে');
  const target = room.members.get(targetId);
  if (!target) throw notFound('That user is not in the room');
  if (target.seat === null) throw badRequest('That user is not on a mic seat');
  if (target.userId === room.ownerId && actor.id !== room.ownerId) throw forbidden('হোস্টকে মিউট করা যাবে না');
  target.isMuted = !!muted;
  run('UPDATE room_members SET is_muted=? WHERE room_id=? AND user_id=?', target.isMuted ? 1 : 0, room.id, targetId);
  return { room, target };
}

/** Appoint / dismiss a room moderator (host only). */
function setModerator(roomId, actor, targetId, isMod) {
  const room = loadRoom(roomId);
  if (!room) throw notFound('Room is closed');
  if (actor.id !== room.ownerId && actor.role !== 'admin') throw forbidden('শুধু হোস্ট মডারেটর নিয়োগ করতে পারে');
  if (targetId === room.ownerId) throw badRequest('হোস্ট নিজেই মডারেটর');
  const target = room.members.get(targetId);
  if (!target) throw notFound('That user is not in the room');
  if (isMod) {
    room.mods.add(targetId);
    run('INSERT OR IGNORE INTO room_mods (room_id, user_id, added_by, created_at) VALUES (?,?,?,?)',
      room.id, targetId, actor.id, Date.now());
  } else {
    room.mods.delete(targetId);
    run('DELETE FROM room_mods WHERE room_id=? AND user_id=?', room.id, targetId);
  }
  return { room, target, isMod: !!isMod };
}

function banFromRoom(roomId, actor, targetId, unban) {
  const room = loadRoom(roomId);
  if (!room) throw notFound('Room is closed');
  if (!canModerate(room, actor)) throw forbidden('শুধু হোস্ট বা মডারেটর এটি করতে পারে');
  if (targetId === room.ownerId) throw badRequest('হোস্টকে ব্যান করা যাবে না');
  if (unban) {
    room.bans.delete(targetId);
    run('DELETE FROM room_bans WHERE room_id=? AND user_id=?', room.id, targetId);
  } else {
    room.bans.add(targetId);
    run('INSERT OR IGNORE INTO room_bans (room_id, user_id, by_id, reason, created_at) VALUES (?,?,?,?,?)',
      room.id, targetId, actor.id, 'banned', Date.now());
  }
  return { room, targetId, banned: !unban };
}

function logModeration(roomId, actorId, targetId, action, note = '') {
  run('INSERT INTO mod_log (id, room_id, actor_id, target_id, action, note, created_at) VALUES (?,?,?,?,?,?,?)',
    uid(), roomId, actorId || null, targetId || null, action, note, Date.now());
}

function modLog(roomId) {
  return all(
    `SELECT l.*, a.display_name actor_name, t.display_name target_name
     FROM mod_log l
     LEFT JOIN users a ON a.id = l.actor_id
     LEFT JOIN users t ON t.id = l.target_id
     WHERE l.room_id = ? ORDER BY l.created_at DESC LIMIT 50`, roomId)
    .map((r) => ({
      id: r.id, action: r.action, note: r.note, createdAt: r.created_at,
      actor: r.actor_name || 'সিস্টেম', target: r.target_name || null,
    }));
}

function lockSeat(roomId, actor, index, locked, forUserId) {
  const room = loadRoom(roomId);
  if (!room) throw notFound('Room is closed');
  if (!canModerate(room, actor)) throw forbidden('শুধু হোস্ট বা মডারেটর এটি করতে পারে');
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= SEATS) throw badRequest('Seat out of range');
  const occupantId = room.seats[i];
  if (occupantId) {
    const m = room.members.get(occupantId);
    if (m) {
      m.isLocked = !!locked;
      run('UPDATE room_members SET is_locked=? WHERE room_id=? AND user_id=?', locked ? 1 : 0, room.id, occupantId);
    }
  } else {
    room.lockedSeats = room.lockedSeats || new Set();
    if (locked) room.lockedSeats.add(i); else room.lockedSeats.delete(i);
  }
  return { room, seat: i, locked: !!locked, occupantId };
}

function raiseHand(roomId, user, up) {
  const room = loadRoom(roomId);
  if (!room) throw notFound('Room is closed');
  const m = room.members.get(user.id);
  if (!m) throw forbidden('Join the room first');
  m.handUp = !!up;
  run('UPDATE room_members SET hand_up=? WHERE room_id=? AND user_id=?', m.handUp ? 1 : 0, room.id, user.id);
  return { room, member: m };
}

function setSpeaking(roomId, userId, speaking) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const m = room.members.get(userId);
  if (!m) return null;
  if (m.speaking === speaking) return null;
  m.speaking = speaking;
  return { room, member: m };
}

function heartbeat(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const m = room.members.get(userId);
  if (!m) return null;
  m.lastSeen = Date.now();
  return { room, member: m };
}

/**
 * Remove a user from the live room. If the host leaves, the room is handed to
 * the longest-seated speaker; if nobody is left the room closes.
 */
function leave(roomId, userId, reason = 'left') {
  const room = rooms.get(roomId);
  if (!room) return null;
  const member = room.members.get(userId);
  if (!member) return null;

  if (member.seat !== null) room.seats[member.seat] = null;
  room.members.delete(userId);
  run('DELETE FROM room_members WHERE room_id=? AND user_id=?', roomId, userId);

  if (room.members.size === 0) {
    closeRoom(roomId, reason === 'host_left' ? 'host_left' : 'empty');
    return { room, closed: true, member };
  }
  if (userId === room.ownerId && reason === 'host_left') {
    const heir = [...room.members.values()].sort((a, b) => (a.joinedAt - b.joinedAt))[0];
    transferHost(room, heir.userId);
  }
  return { room, closed: false, member };
}

function transferHost(room, newOwnerId) {
  const m = room.members.get(newOwnerId);
  if (!m) return null;
  room.ownerId = newOwnerId;
  run('UPDATE rooms SET owner_id = ? WHERE id = ?', newOwnerId, room.id);
  run('UPDATE users SET role = ? WHERE id = ? AND role = ?', 'host', newOwnerId, 'user');
  return m;
}

function closeRoom(roomId, reason = 'closed') {
  const room = rooms.get(roomId);
  if (!room) return null;
  const t = Date.now();
  run('UPDATE rooms SET closed_at = ?, ended_reason = ?, peak_users = ? WHERE id = ? AND closed_at IS NULL',
    t, reason, Math.max(room.peakUsers, room.members.size), roomId);
  run('DELETE FROM room_members WHERE room_id = ?', roomId);
  rooms.delete(roomId);
  return room;
}

/**
 * Periodic sweeper: drop ghosts, keep official rooms stocked, close empty ones.
 *
 * `liveMembers`, when provided, is a Set of "roomId:userId" strings for people
 * whose socket is still connected. Those are never treated as ghosts — a
 * backgrounded phone throttles (or suspends) its timers, so heartbeats alone
 * are not proof that somebody has left.
 */
function sweep(liveMembers) {
  const t = Date.now();
  const closed = [];
  for (const room of rooms.values()) {
    const official = isOfficialRoom(room);

    for (const m of [...room.members.values()]) {
      if (t - m.lastSeen <= GUEST_TTL_MS) continue;
      // a connected socket is the strongest signal of presence
      if (liveMembers && liveMembers.has(`${room.id}:${m.userId}`)) { m.lastSeen = t; continue; }
      // official rooms keep their resident hosts on the mic
      if (official && m.user?.is_bot) { m.lastSeen = t; continue; }
      if (m.seat !== null) room.seats[m.seat] = null;
      room.members.delete(m.userId);
      run('DELETE FROM room_members WHERE room_id=? AND user_id=?', room.id, m.userId);
    }

    if (official) {
      respawnOfficialMembers(room);
      room.emptySince = null;
      room.peakUsers = Math.max(room.peakUsers, room.members.size);
      continue;
    }

    if (room.members.size === 0) {
      if (!room.emptySince) room.emptySince = t;
      if (t - room.emptySince > config.room.emptyRoomTtlMs) closed.push(room.id);
    } else {
      room.emptySince = null;
      room.peakUsers = Math.max(room.peakUsers, room.members.size);
    }
  }
  for (const id of closed) closeRoom(id, 'empty');
  return closed;
}

function roomCount() { return liveRooms().length; }

/**
 * Every open room, loading any that only exist in the database (e.g. after a
 * restart, or rooms created by the seeder).
 */
function liveRooms() {
  const openIds = all('SELECT id FROM rooms WHERE closed_at IS NULL').map((r) => r.id);
  for (const id of openIds) if (!rooms.has(id)) loadRoom(id);
  // drop anything that closed behind our back
  for (const id of [...rooms.keys()]) if (!openIds.includes(id)) rooms.delete(id);
  return [...rooms.values()];
}

/**
 * Rooms whose host is a seeded official account stay open even when empty, so
 * the public grid always has somewhere to go. Real, human-owned rooms close
 * normally once everyone leaves.
 */
function isOfficialRoom(room) {
  const owner = get('SELECT is_bot FROM users WHERE id = ?', room.ownerId);
  return !!(owner && owner.is_bot);
}

/** Put an official room's regulars back on their seats (keeps the grid alive). */
function respawnOfficialMembers(room) {
  const rows = all(
    `SELECT rm.user_id, rm.seat FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = ? AND u.is_bot = 1 AND rm.seat IS NOT NULL
     ORDER BY rm.seat`, room.id);
  const t = Date.now();
  for (const r of rows) {
    if (room.members.has(r.user_id)) { room.members.get(r.user_id).lastSeen = t; continue; }
    const user = get('SELECT * FROM users WHERE id = ?', r.user_id);
    if (!user) continue;
    const member = {
      userId: r.user_id, seat: r.seat, isMuted: true, isLocked: false, handUp: false,
      joinedAt: t, lastSeen: t, speaking: false, user,
    };
    room.members.set(r.user_id, member);
    room.seats[r.seat] = r.user_id;
    run('UPDATE room_members SET last_seen = ? WHERE room_id = ? AND user_id = ?', t, room.id, r.user_id);
  }
}
function getRoom(id) { return rooms.get(id) || null; }
function stats() {
  // Load anything that only exists in the database first, otherwise the very
  // first health check after a restart would report zero live rooms.
  const open = liveRooms();
  let users = 0, speakers = 0;
  for (const r of open) {
    users += r.members.size;
    speakers += r.seats.filter(Boolean).length;
  }
  return { rooms: open.length, users, speakers, seats: open.length * SEATS };
}

module.exports = {
  SEATS, publicUser, publicMember, snapshot, card, join, takeSeat, leaveSeat,
  setMute, setMuteOther, kickFromSeat, lockSeat, raiseHand, setSpeaking, heartbeat, leave,
  closeRoom, transferHost, sweep, loadRoom, getRoom, liveRooms, roomCount, stats,
  isOfficialRoom, respawnOfficialMembers, canModerate, setModerator, banFromRoom,
  logModeration, modLog, GUEST_TTL_MS,
};
