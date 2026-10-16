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

const msgLimiter = limiter('chat', config.limits.msgsPer10s, 10_000);
const giftLimiter = limiter('gift', config.limits.giftsPer10s, 10_000);
const roomCreateLimiter = limiter('room-create', config.limits.roomsCreatedPerHour, 3600_000);

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
    run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), socket.user.id);

    socket.emit('ready', { user: state.publicUser(me()), serverTime: Date.now(), seats: state.SEATS });

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
        systemMessage(room, `${member.user.display_name} took mic seat ${seat + 1}`, 'system', { seat });
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
        emitTo(roomId, 'room:seat', { userId: target.userId, seat: null, member: state.publicMember(target), kicked: true });
        emitUser(target.userId, 'seat:revoked', { roomId, reason: payload?.ban ? 'banned' : 'kicked' });
        systemMessage(room, `${target.user.display_name} was removed from the mic`);
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
        emitTo(roomId, 'room:seatlock', { seat, locked, occupantId });
        broadcastState(room);
        ack?.({ ok: true, seat, locked });
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
        if (p.locked !== undefined) {
          room.locked = !!p.locked;
          systemMessage(room, room.locked ? '🔒 The host locked the room' : '🔓 The room is open again');
        }
        run('UPDATE rooms SET title=?, topic=?, category=?, locked=? WHERE id=?',
          room.title, room.topic, room.category, room.locked ? 1 : 0, room.id);
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
        const body = cleanText(payload?.body, config.limits.maxMsgLen, 'message');
        if (!body) throw badRequest('Empty message');
        const msg = pushMessage(room, {
          id: uid(), kind: 'text', body, userId: user.id,
          user: state.publicUser(user), meta: {}, createdAt: Date.now(),
        });
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
        if (sender.coins < cost) {
          const e = new Error(`Not enough coins — you need ${cost - sender.coins} more`);
          e.code = 'insufficient_coins';
          e.status = 400;
          throw e;
        }

        const hostShare = Math.round((cost * config.economy.hostSharePct) / 100);
        const t = Date.now();

        run('UPDATE users SET coins = coins - ? WHERE id = ?', cost, sender.id);
        run('UPDATE users SET diamonds = diamonds + ?, xp = xp + ? WHERE id = ?', cost, Math.round(cost / 10), target.userId);
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
        const body = cleanText(payload?.body, config.limits.maxMsgLen, 'message');
        if (!body) throw badRequest('Empty message');
        const sender = me();
        const msg = require('./dm').sendDirect(sender, to, body);
        emitUser(to.id, 'dm:new', { message: msg, from: state.publicUser(sender) });
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
    const closed = state.sweep();
    for (const id of closed) io.to(roomChannel(id)).emit('room:closed', { reason: 'empty' });
    const st = state.stats();
    io.emit('server:stats', st);
  }, 15_000).unref();

  // ---- room ambience --------------------------------------------------------
  // Official rooms keep a light chatter going so they never look abandoned.
  const AMBIENT_LINES = [
    'Welcome to the room everyone 🎉',
    'Mic is open — say something 😄',
    'This song is 🔥',
    'Adda korbo, ke acho? 🇧🇩',
    'Follow the host, they are so funny',
    'Gift er jonno wait korchi 🎁',
    'Beautiful voice! 👏',
    'Anyone from Kolkata? ✨',
    'Bhalo lagche sobai mile 🎧',
    'Raise your hand if you want a mic ✋',
  ];
  setInterval(() => {
    for (const room of state.liveRooms()) {
      if (!state.isOfficialRoom(room)) continue;
      // only speak up when a real human is listening
      const humans = [...room.members.values()].filter((m) => connected.has(m.userId));
      if (!humans.length) continue;

      const bots = [...room.members.values()].filter((m) => m.user?.is_bot && m.seat !== null);
      if (!bots.length) continue;
      const bot = bots[Math.floor(Math.random() * bots.length)];

      pushMessage(room, {
        id: uid(), kind: 'text',
        body: AMBIENT_LINES[Math.floor(Math.random() * AMBIENT_LINES.length)],
        userId: bot.userId, user: state.publicUser(bot.user), meta: {}, createdAt: Date.now(),
      });
    }
  }, 22_000).unref();

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
