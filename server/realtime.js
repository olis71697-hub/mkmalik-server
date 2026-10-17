'use strict';

/**
 * Realtime layer (Socket.IO).
 *
 *  • Voice  — WebRTC signalling relay. The server never touches media; it only
 *             brokers SDP/ICE between peers and keeps the seat map authoritative.
 *  • Chat   — room text chat with moderation + rate limits.
 *  • Gifts  — server-authoritative coin economy (client can never self-credit).
 *  • Presence — heartbeat, ghosts, host hand-over, auto-close of empty rooms.
 */

const config = require('./config');
const state = require('./state');
const { all, get, run, now } = require('./db');
const { uid, limiter, badRequest, forbidden, notFound, cleanText } = require('./util');
const { userFromToken } = require('./auth');
const push = require('./push');
const filter = require('./filter');

/** Lazy require — api.js also requires this module, so a top-level require
 *  would create a cycle and hand back a half-built module. */
function awardXpSafe(io, userId, amount) {
  try {
    const { awardXp } = require('./api');
    if (typeof awardXp === 'function') return awardXp(io, userId, amount);
  } catch (_) { /* never let XP break the room */ }
  return null;
}

/** Emoji allowed as live room reactions (spam-guarded whitelist). */
const REACTION_EMOJIS = ['❤️', '😂', '😍', '🔥', '👏', '👍', '😎', '😭', '🥰', '🎉', '👋', '💯'];

const msgLimiter = limiter('chat', config.limits.msgsPer10s, 10_000);
const giftLimiter = limiter('gift', config.limits.giftsPer10s, 10_000);
const roomCreateLimiter = limiter('room-create', config.limits.roomsCreatedPerHour, 3600_000);
const reactionLimiter = limiter('reaction', config.limits.reactionsPer10s, 10_000);

const GUEST_TTL_MS = 45_000;

/**
 * Users with a live socket right now. Only these can form a WebRTC connection —
 * seeded "official" accounts hold mic seats but have no browser, so connecting
 * to them would just stall.
 */
const connected = new Set();

function mount(io) {
  // ---- handshake auth -----------------------------------------------------
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('AUTH_REQUIRED'));
    try {
      socket.user = userFromToken(token);
      socket.data.roomId = null;
      next();
    } catch (e) {
      next(new Error('AUTH_FAILED'));
    }
  });

  const roomChannel = (roomId) => `room:${roomId}`;
  const userChannel = (userId) => `user:${userId}`;

  // -------- fan-out helpers ------------------------------------------------
  function broadcastState(room) {
    io.to(roomChannel(room.id)).emit('room:state', state.snapshot(room, null));
  }
  function emitTo(roomId, event, payload) {
    io.to(roomChannel(roomId)).emit(event, payload);
  }
  function emitUser(userId, event, payload) {
    io.to(userChannel(userId)).emit(event, payload);
  }

  /**
   * After any seat change, every connected member may need a different set of
   * peer connections. Push a personalised list to each of them.
   */
  function syncPeers(room) {
    for (const m of room.members.values()) {
      if (!connected.has(m.userId)) continue;
      emitUser(m.userId, 'room:peers', { roomId: room.id, peers: peersFor(room, m.userId) });
    }
    io.to(roomChannel(room.id)).emit('room:seat_sync', { roomId: room.id });
  }

  function pushMessage(room, msg) {
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.splice(0, room.messages.length - 120);
    run(`INSERT INTO room_messages (id, room_id, user_id, kind, body, meta, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      msg.id, room.id, msg.userId || null, msg.kind, msg.body || '', JSON.stringify(msg.meta || {}), msg.createdAt);
    emitTo(room.id, 'room:message', msg);
    return msg;
  }

  function systemMessage(room, body, kind = 'system', meta = {}) {
    return pushMessage(room, {
      id: uid(), kind, body, userId: null, user: null, meta, createdAt: Date.now(),
    });
  }

  async function resolveRoom(socket, roomId) {
    const room = state.loadRoom(roomId);
    if (!room) throw notFound('Room not found or already closed');
    return room;
  }

  // -------------------------------------------------------------------------
  io.on('connection', (socket) => {
    const me = () => {
      const fresh = get('SELECT * FROM users WHERE id = ?', socket.user.id);
      return fresh || socket.user;
    };

    connected.add(socket.user.id);
    socket.join(userChannel(socket.user.id));
    const wasOffline = !io.sockets.sockets ? true : ![...io.sockets.sockets.values()].some(
      (s) => s.id !== socket.id && s.user?.id === socket.user.id);
    run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), socket.user.id);

    socket.emit('ready', { user: state.publicUser(me()), serverTime: Date.now(), seats: state.SEATS });

    // followers who asked for it hear that I came online
    if (wasOffline) {
      const meRow = me();
      if (meRow) {
        const followers = all(
          `SELECT f.follower_id FROM follows f JOIN user_settings s ON s.user_id = f.follower_id
           WHERE f.target_id = ? AND s.notify_follow = 1 LIMIT 200`, socket.user.id);
        for (const f of followers) {
          emitUser(f.follower_id, 'presence:online', {
            userId: socket.user.id, displayName: meRow.display_name, avatar: meRow.avatar,
          });
        }
      }
      io.emit('presence:online', { userId: socket.user.id });
    }

    // ---- presence: everyone in my rooms gets "online" -----------------------
    socket.on('presence:ping', (ack) => {
      run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), socket.user.id);
      if (socket.data.roomId) {
        const hb = state.heartbeat(socket.data.roomId, socket.user.id);
        if (hb && hb.member.handUp !== undefined) { /* keep alive only */ }
      }
      if (typeof ack === 'function') ack({ ok: true, t: Date.now() });
    });

    // ---- join / leave room --------------------------------------------------
    socket.on('room:join', async (payload, ack) => {
      try {
        const { roomId, seat, pin } = payload || {};
        if (!roomId) throw badRequest('roomId required');
        if (socket.data.roomId === roomId) {
          return ack?.({ ok: true, room: state.snapshot(state.loadRoom(roomId), socket.user.id), resumed: true });
        }
        if (socket.data.roomId) await doLeave(socket, 'switch');

        const user = me();
        const { room, member, wasAlreadyIn } = state.join(roomId, user, { seat, pin });

        socket.data.roomId = room.id;
        socket.join(roomChannel(room.id));
        socket.data.seat = member.seat;

        ack?.({
          ok: true,
          room: state.snapshot(room, socket.user.id),
          // who I must open a peer connection to
          peers: peersFor(room, socket.user.id),
        });

        if (!wasAlreadyIn) {
          systemMessage(room, `${user.display_name} joined the room`);
          socket.to(roomChannel(room.id)).emit('room:member_join', {
            member: state.publicMember(member), room: state.snapshot(room, null),
          });
        }
        broadcastState(room);
        syncPeers(room);
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    socket.on('room:leave', async (_p, ack) => {
      await doLeave(socket, 'left');
      ack?.({ ok: true });
    });

    socket.on('room:snapshot', async (payload, ack) => {
      const roomId = payload?.roomId || socket.data.roomId;
      const room = state.loadRoom(roomId);
      if (!room) return ack?.({ ok: false, error: 'Room closed' });
      ack?.({ ok: true, room: state.snapshot(room, socket.user.id), peers: peersFor(room, socket.user.id) });
    });

    // ---- mic seats ----------------------------------------------------------
    socket.on('seat:take', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const { room, member, seat } = state.takeSeat(roomId, me(), payload?.index);
        socket.data.seat = seat;
        awardXpSafe(io, member.userId, 10);
        systemMessage(room, `${member.user.display_name} সিট ${seat + 1} নিল 🎙️`, 'system', { seat });
        emitTo(roomId, 'room:seat', { userId: member.userId, seat, isMuted: true, member: state.publicMember(member) });
        broadcastState(room);
        syncPeers(room);
        ack?.({ ok: true, seat, peers: peersFor(room, socket.user.id) });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    socket.on('seat:leave', (_p, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const res = state.leaveSeat(roomId, me());
        socket.data.seat = null;
        if (res?.room) {
          emitTo(roomId, 'room:seat', { userId: socket.user.id, seat: null, member: state.publicMember(res.member) });
          if (res.promoted) {
            emitTo(roomId, 'room:seat', { userId: res.promoted.userId, seat: res.seat, isMuted: true, member: state.publicMember(res.promoted), promoted: true });
            systemMessage(res.room, `${res.promoted.user.display_name} was moved up to the mic`, 'system', { seat: res.seat });
            emitUser(res.promoted.userId, 'seat:granted', { roomId, seat: res.seat });
          }
          broadcastState(res.room);
          syncPeers(res.room);
          ack?.({ ok: true, promoted: res.promoted ? state.publicMember(res.promoted) : null });
        } else ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    socket.on('seat:mute', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const { room, member } = state.setMute(roomId, me(), !!payload?.muted);
        emitTo(roomId, 'room:seat', { userId: member.userId, seat: member.seat, isMuted: member.isMuted, member: state.publicMember(member) });
        ack?.({ ok: true, muted: member.isMuted });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    socket.on('seat:kick', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const { room, target } = state.kickFromSeat(roomId, me(), payload?.userId, !!payload?.ban);
        state.logModeration(roomId, socket.user.id, target.userId, payload?.ban ? 'ban' : 'kick');
        emitTo(roomId, 'room:seat', { userId: target.userId, seat: null, member: state.publicMember(target), kicked: true });
        emitUser(target.userId, 'seat:revoked', { roomId, reason: payload?.ban ? 'banned' : 'kicked' });
        systemMessage(room, `${target.user.display_name}-কে মাইক থেকে সরানো হয়েছে`);
        broadcastState(room);
        syncPeers(room);
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    socket.on('seat:lock', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const { room, seat, locked, occupantId } = state.lockSeat(roomId, me(), payload?.index, !!payload?.locked);
        state.logModeration(roomId, socket.user.id, occupantId || null, locked ? 'lock' : 'unlock', `seat ${seat + 1}`);
        emitTo(roomId, 'room:seatlock', { seat, locked, occupantId });
        broadcastState(room);
        ack?.({ ok: true, seat, locked });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    // ---- host/moderator: invite a listener to a specific seat ---------------
    socket.on('seat:invite', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const room = state.loadRoom(roomId);
        const user = me();
        if (!state.canModerate(room, user)) throw forbidden('শুধু হোস্ট বা মডারেটর এটি করতে পারে');
        const targetId = String(payload?.userId || '');
        const target = room.members.get(targetId);
        if (!target) throw notFound('That user is not in the room');
        if (target.seat !== null) throw badRequest('Already on a mic seat');
        let seat = payload?.seat;
        if (seat === undefined || seat === null) seat = room.seats.findIndex((s) => !s);
        if (seat < 0 || seat >= state.SEATS || room.seats[seat]) throw badRequest('That seat is not free');
        emitUser(targetId, 'seat:invited', {
          roomId, seat, byName: user.display_name, at: Date.now(),
        });
        ack?.({ ok: true, seat });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    // ---- host/moderator: force-mute another seated user ---------------------
    socket.on('seat:mute_other', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const { room, target } = state.setMuteOther(roomId, me(), String(payload?.userId || ''), !!payload?.muted);
        state.logModeration(roomId, socket.user.id, target.userId, 'mute', payload?.muted ? 'muted' : 'unmuted');
        emitTo(roomId, 'room:seat', {
          userId: target.userId, seat: target.seat, isMuted: target.isMuted,
          member: state.publicMember(target), forcedBy: socket.user.id,
        });
        emitUser(target.userId, 'seat:force_muted', { roomId, muted: target.isMuted, by: socket.user.id });
        systemMessage(room, target.isMuted
          ? `🔇 হোস্ট ${target.user.display_name}-কে মিউট করেছে`
          : `🔊 ${target.user.display_name} এখন আনমিউট`, 'system');
        broadcastState(room);
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    // ---- host: appoint / dismiss moderators ---------------------------------
    socket.on('mod:set', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const { room, target, isMod } = state.setModerator(roomId, me(), String(payload?.userId || ''), !!payload?.isMod);
        state.logModeration(roomId, socket.user.id, target.userId, isMod ? 'mod_add' : 'mod_remove');
        systemMessage(room, isMod
          ? `🛡️ ${target.user.display_name} এখন এই রুমের মডারেটর`
          : `${target.user.display_name} আর মডারেটর নন`, 'system');
        broadcastState(room);
        ack?.({ ok: true, isMod });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    // ---- host/moderator: ban / unban from the room --------------------------
    socket.on('room:ban', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const { room, targetId, banned } = state.banFromRoom(roomId, me(), String(payload?.userId || ''), !!payload?.unban);
        if (banned) {
          state.logModeration(roomId, socket.user.id, targetId, 'ban');
          const target = room.members.get(targetId);
          if (target) {
            if (target.seat !== null) room.seats[target.seat] = null;
            room.members.delete(targetId);
            run('DELETE FROM room_members WHERE room_id=? AND user_id=?', roomId, targetId);
            emitUser(targetId, 'room:closed', { roomId, reason: 'banned' });
            systemMessage(room, `⛔ ${target.user?.display_name || 'একজন ইউজার'}-কে রুম থেকে ব্যান করা হয়েছে`);
          }
        } else {
          state.logModeration(roomId, socket.user.id, targetId, 'unban');
          systemMessage(room, 'একজন ইউজারের ব্যান তুলে নেওয়া হয়েছে');
        }
        broadcastState(room);
        syncPeers(room);
        ack?.({ ok: true, banned });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    // ---- moderation log (host/mod) ------------------------------------------
    socket.on('room:modlog', (_p, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const room = state.loadRoom(roomId);
        const user = me();
        if (!state.canModerate(room, user)) throw forbidden('শুধু হোস্ট বা মডারেটর দেখতে পারে');
        ack?.({ ok: true, log: state.modLog(roomId) });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    // ---- emoji reactions (rate-limited whitelist) ---------------------------
    socket.on('reaction:send', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        reactionLimiter.hit(socket.user.id);
        const emoji = String(payload?.emoji || '');
        if (!REACTION_EMOJIS.includes(emoji)) throw badRequest('এই ইমোজিটি অনুমোদিত নয়');
        emitTo(roomId, 'room:reaction', {
          userId: socket.user.id,
          displayName: me().display_name,
          emoji, at: Date.now(),
        });
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    socket.on('hand:raise', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const { room, member } = state.raiseHand(roomId, me(), payload?.up !== false);
        emitTo(roomId, 'room:hand', { userId: member.userId, up: member.handUp, member: state.publicMember(member) });
        if (member.handUp) {
          const host = room.members.get(room.ownerId);
          if (host) systemMessage(room, `${member.user.display_name} raised a hand ✋`);
        }
        ack?.({ ok: true, up: member.handUp });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    socket.on('room:update', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        const room = state.loadRoom(roomId);
        const user = me();
        if (room.ownerId !== user.id && user.role !== 'admin') throw forbidden('Only the host can edit the room');
        const p = payload || {};
        if (p.title !== undefined) room.title = cleanText(p.title, config.limits.maxRoomTitleLen, 'title') || room.title;
        if (p.topic !== undefined) room.topic = cleanText(p.topic, 120, 'topic');
        if (p.category !== undefined && /^[a-z]{2,16}$/.test(p.category)) room.category = p.category;
        if (p.rules !== undefined) room.rules = cleanText(p.rules, 300, 'rules');
        if (p.chatOpen !== undefined) {
          room.chatOpen = !!p.chatOpen;
          systemMessage(room, room.chatOpen ? '💬 চ্যাট আবার চালু' : '🔇 হোস্ট চ্যাট বন্ধ করেছে');
        }
        if (p.theme !== undefined && /^[a-z]{2,12}$/.test(p.theme)) room.theme = p.theme;
        if (p.locked !== undefined) {
          room.locked = !!p.locked;
          systemMessage(room, room.locked ? '🔒 The host locked the room' : '🔓 The room is open again');
        }
        run('UPDATE rooms SET title=?, topic=?, category=?, locked=?, rules=?, chat_open=?, theme=? WHERE id=?',
          room.title, room.topic, room.category, room.locked ? 1 : 0, room.rules, room.chatOpen === false ? 0 : 1, room.theme, room.id);
        broadcastState(room);
        ack?.({ ok: true, room: state.snapshot(room, user.id) });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    socket.on('room:end', (_p, ack) => {
      try {
        const roomId = socket.data.roomId;
        const user = me();
        const room = state.loadRoom(roomId);
        if (!room) throw notFound('Room not found');
        if (room.ownerId !== user.id && user.role !== 'admin') throw forbidden('Only the host can end the room');
        emitTo(roomId, 'room:closed', { reason: 'host_ended' });
        for (const m of room.members.values()) emitUser(m.userId, 'room:closed', { roomId, reason: 'host_ended' });
        for (const s of io.sockets.adapter.rooms.get(roomChannel(roomId)) || []) io.sockets.sockets.get(s)?.leave(roomChannel(roomId));
        state.closeRoom(roomId, 'host_ended');
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    // ---- chat ---------------------------------------------------------------
    socket.on('chat:send', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        msgLimiter.hit(socket.user.id);
        const room = state.loadRoom(roomId);
        if (!room) throw notFound('Room closed');
        const user = me();
        if (room.chatOpen === false && room.ownerId !== user.id && !room.mods.has(user.id) && user.role !== 'admin') {
          throw forbidden('হোস্ট চ্যাট বন্ধ রেখেছে', 'chat_closed');
        }
        if (filter.isTimedOut(user.id)) {
          throw forbidden(`আপনি সাময়িকভাবে চ্যাটে নিষিদ্ধ (অশ্লীলতা/স্প্যাম) — ${Math.ceil(filter.timeoutLeftSec(user.id) / 60)} মিনিট পরে আবার চেষ্টা করুন`, 'chat_timeout');
        }
        const body = cleanText(payload?.body, config.limits.maxMsgLen, 'message');
        if (!body) throw badRequest('Empty message');
        const verdict = filter.checkText(body);
        if (!verdict.ok) {
          filter.recordStrike(user.id);
          throw forbidden('বার্তাটি পাঠানো যায়নি — অশ্লীল/আপত্তিকর ভাষা ফিল্টার করা হয়েছে', 'chat_filtered');
        }
        const msg = pushMessage(room, {
          id: uid(), kind: 'text', body, userId: user.id,
          user: state.publicUser(user), meta: {}, createdAt: Date.now(),
        });
        awardXpSafe(io, user.id, 1);
        ack?.({ ok: true, message: msg });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    // ---- gifts (server-authoritative economy) -------------------------------
    socket.on('gift:send', (payload, ack) => {
      try {
        const roomId = socket.data.roomId;
        if (!roomId) throw forbidden('Join a room first');
        giftLimiter.hit(socket.user.id);
        const room = state.loadRoom(roomId);
        if (!room) throw notFound('Room closed');

        const sender = me();
        const toId = String(payload?.toUserId || '');
        const gift = get('SELECT * FROM gift_catalog WHERE id = ?', String(payload?.giftId || ''));
        if (!gift) throw badRequest('Unknown gift');
        const qty = Math.max(1, Math.min(99, Number(payload?.qty) || 1));
        const cost = gift.price * qty;

        const target = room.members.get(toId);
        if (!target) throw notFound('That person is not in this room');
        if (target.userId === sender.id) throw badRequest('You cannot gift yourself');
        if (get('SELECT 1 FROM blocks WHERE (blocker_id = ? AND target_id = ?) OR (blocker_id = ? AND target_id = ?)',
          sender.id, target.userId, target.userId, sender.id)) {
          throw forbidden('এই ইউজারকে গিফট পাঠানো যাবে না', 'blocked');
        }
        if (sender.coins < cost) {
          const e = new Error(`Not enough coins — you need ${cost - sender.coins} more`);
          e.code = 'insufficient_coins';
          e.status = 400;
          throw e;
        }

        const hostShare = Math.round((cost * config.economy.hostSharePct) / 100);
        const t = Date.now();

        run('UPDATE users SET coins = coins - ? WHERE id = ?', cost, sender.id);
        run('UPDATE users SET diamonds = diamonds + ? WHERE id = ?', cost, target.userId);
        if (room.ownerId !== target.userId) {
          run('UPDATE users SET diamonds = diamonds + ? WHERE id = ?', hostShare, room.ownerId);
        }
        awardXpSafe(io, sender.id, Math.round(cost / 20));
        awardXpSafe(io, target.userId, Math.round(cost / 10));
        if (room.ownerId !== target.userId) awardXpSafe(io, room.ownerId, Math.round(hostShare / 20));
        // heavy gifters earn VIP
        if (target.user && !target.user.vip) {
          const after = get('SELECT diamonds FROM users WHERE id = ?', target.userId);
          if (after && after.diamonds >= 5000) run('UPDATE users SET vip = 1 WHERE id = ?', target.userId);
        }
        if (room.ownerId !== target.userId) {
          run('UPDATE users SET diamonds = diamonds + ?, xp = xp + ? WHERE id = ?', hostShare, Math.round(hostShare / 20), room.ownerId);
        }
        run('UPDATE rooms SET gift_coins = gift_coins + ? WHERE id = ?', cost, room.id);
        room.giftCoins += cost;
        run('INSERT INTO gift_events (id, room_id, from_id, to_id, gift_id, qty, coins, created_at) VALUES (?,?,?,?,?,?,?,?)',
          uid(), room.id, sender.id, target.userId, gift.id, qty, cost, t);
        run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
          uid(), sender.id, -cost, 'gift_sent', JSON.stringify({ giftId: gift.id, to: target.userId, roomId: room.id }), t);
        run('INSERT INTO coin_ledger (id, user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?,?)',
          uid(), target.userId, cost, 'gift_received', JSON.stringify({ giftId: gift.id, from: sender.id }), t);

        const event = {
          id: uid(), gift: { id: gift.id, name: gift.name, emoji: gift.emoji, price: gift.price, anim: gift.anim },
          qty, coins: cost, from: state.publicUser(sender), to: state.publicMember(target),
          createdAt: t, roomId: room.id,
        };
        emitTo(room.id, 'room:gift', event);
        pushMessage(room, {
          id: uid(), kind: 'gift', userId: sender.id, user: state.publicUser(sender),
          body: `sent ${gift.emoji} ${gift.name} ×${qty} to ${target.user.display_name}`,
          meta: { giftId: gift.id, qty, coins: cost, to: target.userId }, createdAt: t,
        });
        emitUser(target.userId, 'notification', { kind: 'gift', title: 'You received a gift!', body: `${sender.display_name} sent ${gift.emoji} ${gift.name} ×${qty}` });
        push.sendToUser(target.userId, {
          kind: 'gift', title: 'You received a gift! 🎁',
          body: `${sender.display_name} sent ${gift.emoji} ${gift.name} ×${qty}`, tag: 'gift', url: './',
        }).catch(() => {});
        broadcastState(room);

        ack?.({ ok: true, coins: sender.coins - cost, event });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    // ---- WebRTC signalling (opaque relay) -----------------------------------
    // payload: { to: userId, data: { type: 'offer'|'answer'|'candidate', ... } }
    socket.on('rtc:signal', (payload) => {
      const to = payload?.to;
      const roomId = socket.data.roomId;
      if (!to || !roomId) return;
      const room = state.getRoom(roomId);
      if (!room || !room.members.has(to)) return;
      const data = payload.data;
      if (!data || typeof data !== 'object') return;
      // basic guard: never relay arbitrary large blobs
      if (JSON.stringify(data).length > 60_000) return;
      emitUser(to, 'rtc:signal', { from: socket.user.id, data, roomId });
    });

    // A newly seated speaker tells everyone to (re)negotiate with them.
    socket.on('rtc:announce', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = state.getRoom(roomId);
      if (!room) return;
      broadcastState(room);
    });

    socket.on('rtc:speaking', (payload) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const res = state.setSpeaking(roomId, socket.user.id, !!payload?.speaking);
      if (res) socket.to(roomChannel(roomId)).emit('room:speaking', { userId: socket.user.id, speaking: res.member.speaking });
    });

    // ---- direct messages ----------------------------------------------------
    socket.on('dm:send', (payload, ack) => {
      try {
        msgLimiter.hit('dm:' + socket.user.id);
        const toId = String(payload?.toUserId || '');
        const to = get('SELECT * FROM users WHERE id = ?', toId);
        if (!to) throw notFound('User not found');
        if (get('SELECT 1 FROM blocks WHERE (blocker_id = ? AND target_id = ?) OR (blocker_id = ? AND target_id = ?)',
          socket.user.id, to.id, to.id, socket.user.id)) {
          throw forbidden('এই ইউজারকে মেসেজ পাঠানো যাবে না (ব্লক)', 'blocked');
        }
        const toSettings = get('SELECT * FROM user_settings WHERE user_id = ?', to.id);
        const privacy = toSettings?.dm_privacy || 'everyone';
        if (privacy === 'nobody') throw forbidden('এই ইউজার কারও কাছ থেকে মেসেজ গ্রহণ করেন না', 'dm_private');
        if (privacy === 'following' && !get('SELECT 1 FROM follows WHERE follower_id = ? AND target_id = ?', to.id, socket.user.id)) {
          throw forbidden('শুধুমাত্র ফলোয়াররাই এই ইউজারকে মেসেজ পাঠাতে পারে', 'dm_private');
        }
        if (filter.isTimedOut(socket.user.id)) {
          throw forbidden(`আপনি সাময়িকভাবে চ্যাটে নিষিদ্ধ (অশ্লীলতা/স্প্যাম) — ${Math.ceil(filter.timeoutLeftSec(socket.user.id) / 60)} মিনিট পরে আবার চেষ্টা করুন`, 'chat_timeout');
        }
        const body = cleanText(payload?.body, config.limits.maxMsgLen, 'message');
        if (!body) throw badRequest('Empty message');
        if (!filter.checkText(body).ok) {
          filter.recordStrike(socket.user.id);
          throw forbidden('বার্তাটি পাঠানো যায়নি — অশ্লীল/আপত্তিকর ভাষা ফিল্টার করা হয়েছে', 'chat_filtered');
        }
        const sender = me();
        const msg = require('./dm').sendDirect(sender, to, body);
        emitUser(to.id, 'dm:new', { message: msg, from: state.publicUser(sender) });
        push.sendToUser(to.id, {
          kind: 'dm', title: sender.display_name,
          body: body.slice(0, 90), tag: 'dm-' + sender.id, url: './',
        }).catch(() => {});
        ack?.({ ok: true, message: msg });
      } catch (e) { ack?.({ ok: false, error: e.message, code: e.code }); }
    });

    // ---- typing / read receipts --------------------------------------------
    socket.on('dm:typing', (p) => {
      const to = p?.toUserId;
      if (to) emitUser(to, 'dm:typing', { from: socket.user.id, typing: !!p.typing });
    });

    // ---- graceful disconnect -------------------------------------------------
    socket.on('disconnect', async () => {
      if (socket.data.roomId) await doLeave(socket, 'disconnected', true);
      // only mark fully offline once every tab for this user has gone
      const stillOnline = [...io.sockets.sockets.values()].some((s) => s.id !== socket.id && s.user?.id === socket.user.id);
      if (!stillOnline) {
        connected.delete(socket.user.id);
        run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), socket.user.id);
        io.emit('presence:offline', { userId: socket.user.id });
      }
    });

    // -----------------------------------------------------------------------
    async function doLeave(sock, reason) {
      const roomId = sock.data.roomId;
      if (!roomId) return;
      sock.data.roomId = null;
      sock.data.seat = null;
      const user = sock.user;
      const res = state.leave(roomId, user.id, reason === 'disconnected' ? 'left' : reason);
      sock.leave(roomChannel(roomId));
      if (!res) return;
      if (res.closed) {
        io.to(roomChannel(roomId)).emit('room:closed', { reason: 'empty' });
        return;
      }
      const { room } = res;
      systemMessage(room, `${user.display_name} left the room`);
      emitTo(roomId, 'room:member_leave', { userId: user.id, room: state.snapshot(room, null) });
      broadcastState(room);
    }
  });

  // ---- background sweeper ---------------------------------------------------
  setInterval(() => {
    // Anyone whose socket is still in the room counts as present, no matter how
    // badly the browser throttled their heartbeat timers.
    const liveMembers = new Set();
    for (const s of io.sockets.sockets.values()) {
      if (s.data?.roomId && s.user?.id) liveMembers.add(`${s.data.roomId}:${s.user.id}`);
    }
    const closed = state.sweep(liveMembers);
    for (const id of closed) io.to(roomChannel(id)).emit('room:closed', { reason: 'empty' });
    const st = state.stats();
    io.emit('server:stats', st);
  }, 15_000).unref();

  // (No fake ambience — rooms are quiet until real people speak in them.)

  return io;
}

/**
 * Which peers a given user should hold a WebRTC connection with.
 *   speaker ↔ speaker  : two-way audio
 *   speaker ← listener : speaker sends, listener receives
 *   listener ↔ listener: never (no audio path needed)
 */
function peersFor(room, userId) {
  const out = [];
  const self = room.members.get(userId);
  if (!self) return out;
  const selfIsSpeaker = self.seat !== null;
  for (const m of room.members.values()) {
    if (m.userId === userId) continue;
    const otherIsSpeaker = m.seat !== null;
    if (!selfIsSpeaker && !otherIsSpeaker) continue;
    // no browser on the other end → no media path to build
    if (!connected.has(m.userId)) continue;
    out.push({
      userId: m.userId,
      // 'sendrecv' = I publish and receive, 'recvonly' = I only listen,
      // 'sendonly' = I only publish (mirror of the peer's recvonly)
      direction: selfIsSpeaker && otherIsSpeaker ? 'sendrecv' : (selfIsSpeaker ? 'sendonly' : 'recvonly'),
      // deterministic initiator so both sides never offer at once
      initiator: String(userId) < String(m.userId),
    });
  }
  return out;
}

module.exports = { mount, peersFor, connected };
