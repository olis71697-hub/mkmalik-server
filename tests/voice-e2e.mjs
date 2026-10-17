/*
 * Panda Voice — integration test.
 * Start the server first (npm start), then:  npm test
 * Override the target with BASE_URL=http://host:port
 */
/* End-to-end: two real clients, one room, real WebRTC signalling relay. */
import { io } from 'socket.io-client';

import { BASE, sleep, apiFetch, freshUser, createRoom, emitAck, makeReporter } from './helpers.mjs';

function connect(token) {
  return new Promise((resolve, reject) => {
    const sock = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    sock.on('ready', () => resolve(sock));
    sock.on('connect_error', (e) => reject(new Error('connect_error: ' + e.message)));
    setTimeout(() => reject(new Error('socket timeout')), 6000);
  });
}

/**
 * Create a throwaway account for this run. Integration tests must not depend on
 * state left behind by earlier runs — the per-user room-creation limit would
 * otherwise trip after a few executions within the same hour.
 */

const R = makeReporter('LIVE VOICE ROOM — END TO END');
const check = R.check;

const A = await freshUser();
const B = await freshUser();
console.log('  accounts:', A.user.displayName, '&', B.user.displayName);

const sockA = await connect(A.token);
const sockB = await connect(B.token);
// record every peer-list push so assertions never race the network
const peersBoxA = [], peersBoxB = [];
sockA.on('room:peers', (p) => peersBoxA.push(p.peers));
sockB.on('room:peers', (p) => peersBoxB.push(p.peers));
const lastDir = (box, otherId) => box.at(-1)?.find((p) => p.userId === otherId)?.direction;
check('both clients authenticated over websocket', !!sockA.id && !!sockB.id, `${sockA.id.slice(0,6)} / ${sockB.id.slice(0,6)}`);

R.section('A opens a room');
const created = await createRoom(A.token, { title: 'Voice test room', category: 'party', tags: ['test'] });
const roomId = created.room.id;
check('room created', !!roomId, created.room.title);

R.section('A joins and takes seat 1');
const joinA = await emitAck(sockA, 'room:join', { roomId, seat: true });
check('A joined + auto-seated', joinA.ok && joinA.room.viewer.seat === 0, `seat ${joinA.room?.viewer?.seat}`);

R.section('B joins as a listener');
const joinB = await emitAck(sockB, 'room:join', { roomId });
check('B joined as listener', joinB.ok && joinB.room.viewer.seat === null);
check('B sees A on mic seat 1', joinB.room.seats[0]?.userId === A.user.id);
check('B got a peer to listen to (A)', joinB.peers.some((p) => p.userId === A.user.id),
  JSON.stringify(joinB.peers));

const bPeerToA = joinB.peers.find((p) => p.userId === A.user.id);
check('listener direction is recvonly', bPeerToA?.direction === 'recvonly', bPeerToA?.direction);

R.section('A should learn about B (speaker publishes to listener)');
await sleep(400);
check('A was told to publish toward B',
  ['sendonly', 'sendrecv'].includes(lastDir(peersBoxA, B.user.id)),
  'A→B ' + lastDir(peersBoxA, B.user.id));

const offerForB = { type: 'description', description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } };
const gotOffer = new Promise((resolve) => sockB.once('rtc:signal', resolve));
sockA.emit('rtc:signal', { to: B.user.id, data: offerForB });
const offerRes = await Promise.race([gotOffer, sleep(3000).then(() => null)]);
check('offer relayed A → B', offerRes?.from === A.user.id && offerRes?.data?.description?.type === 'offer');

const answerForA = { type: 'description', description: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } };
const gotAnswer = new Promise((resolve) => sockA.once('rtc:signal', resolve));
sockB.emit('rtc:signal', { to: A.user.id, data: answerForA });
const answerRes = await Promise.race([gotAnswer, sleep(3000).then(() => null)]);
check('answer relayed B → A', answerRes?.from === B.user.id && answerRes?.data?.description?.type === 'answer');

const iceForB = { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 2130706431 192.168.1.5 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
const gotIce = new Promise((resolve) => sockB.once('rtc:signal', resolve));
sockA.emit('rtc:signal', { to: B.user.id, data: iceForB });
const iceRes = await Promise.race([gotIce, sleep(3000).then(() => null)]);
check('ICE candidate relayed A → B', iceRes?.data?.type === 'candidate');

// a stranger must NOT be able to inject signalling into this room
const C = await freshUser();
const sockC = await connect(C.token);
let injected = false;
sockC.once('rtc:signal', () => { injected = true; });
sockC.emit('rtc:signal', { to: B.user.id, data: { type: 'description', description: { type: 'offer', sdp: 'evil' } } });
await sleep(500);
check('outsider cannot inject signalling', !injected);
sockC.disconnect();

R.section('B takes seat 2 → both become speakers, direction flips to sendrecv');
const seatB = await emitAck(sockB, 'seat:take', { index: 1 });
check('B took mic seat 2', seatB.ok && seatB.seat === 1);

await sleep(400);
check('speaker↔speaker becomes sendrecv',
  lastDir(peersBoxB, A.user.id) === 'sendrecv' && lastDir(peersBoxA, B.user.id) === 'sendrecv',
  `A→B ${lastDir(peersBoxA, B.user.id)}, B→A ${lastDir(peersBoxB, A.user.id)}`);

R.section('mute state');
const muteRes = await emitAck(sockB, 'seat:mute', { muted: true });
check('mic mute acknowledged', muteRes.ok && muteRes.muted === true);

R.section('chat in the room');
const chatGot = new Promise((resolve) => sockB.once('room:message', resolve));
const chatSent = await emitAck(sockA, 'chat:send', { body: 'Hello from the test 👋' });
const chatMsg = await Promise.race([chatGot, sleep(3000).then(() => null)]);
check('message broadcast to the other person', chatMsg?.body === 'Hello from the test 👋', chatMsg?.user?.displayName);

R.section('gifts move coins, server-side');
const beforeA = (await apiFetch('/api/me', { token: A.token })).data.user.coins;
const beforeB = (await apiFetch('/api/me', { token: B.token })).data.user.diamonds;

const giftFx = new Promise((resolve) => sockB.once('room:gift', resolve));
const giftRes = await emitAck(sockA, 'gift:send', { giftId: 'rose', toUserId: B.user.id, qty: 5 });
const fx = await Promise.race([giftFx, sleep(3000).then(() => null)]);
check('gift accepted', giftRes.ok, `rose ×5 = ${giftRes.event?.coins} coins`);
check('gift broadcast for the animation', fx?.gift?.emoji === '🌹' && fx?.qty === 5);

const afterA = (await apiFetch('/api/me', { token: A.token })).data.user.coins;
const afterB = (await apiFetch('/api/me', { token: B.token })).data.user.diamonds;
const { gifts: catalog } = (await apiFetch('/api/gifts')).data;
const rosePrice = catalog.find((g) => g.id === 'rose')?.price || 10;
const spent = rosePrice * 5;
check('sender coins deducted', beforeA - afterA === spent, `${beforeA} → ${afterA} (rose=${rosePrice})`);
check('receiver diamonds credited', afterB - beforeB === spent, `${beforeB} → ${afterB}`);

R.section('diamond → coin exchange (real economy, no gateway)');
const meB1 = (await apiFetch('/api/me', { token: B.token })).data.user;
const ex = await apiFetch('/api/wallet/exchange', { method: 'POST', token: B.token, body: { diamonds: 50 } });
const meB2 = (await apiFetch('/api/me', { token: B.token })).data.user;
check('exchange credits coins minus the 10% fee',
  ex.ok && ex.data?.credited === 45 && meB2.coins - meB1.coins === 45 && meB1.diamonds - meB2.diamonds === 50,
  `50 💎 → ${ex.data?.credited} 🪙 (${meB1.coins}→${meB2.coins} coins)`);
const exSmall = await apiFetch('/api/wallet/exchange', { method: 'POST', token: B.token, body: { diamonds: 5 } });
check('exchange enforces the minimum', !exSmall.ok && exSmall.data?.code === 'exchange_min', `HTTP ${exSmall.status} ${exSmall.data?.code}`);

R.section('purchases stay honest without a real gateway');
const pu = await apiFetch('/api/wallet/purchase', {
  method: 'POST', token: A.token,
  body: { packageId: 'p100', paymentMethod: 'bkash', paymentRef: 'MOCK-TRYFAKE123' },
});
check('no mock purchase is ever credited', pu.status === 503 && pu.data?.code === 'payments_not_configured',
  `HTTP ${pu.status} ${pu.data?.code}`);
const otpTry = await apiFetch('/api/auth/otp/request', { method: 'POST', body: { phone: '01700000000' } });
check('phone OTP stays disabled until an SMS gateway exists',
  otpTry.status === 503 && otpTry.data?.code === 'sms_not_configured',
  `HTTP ${otpTry.status} ${otpTry.data?.code}`);

// client may not mint coins
const cheat = await emitAck(sockA, 'gift:send', { giftId: 'dragon', toUserId: B.user.id, qty: 99 });
check('unaffordable gift is rejected by the server', cheat.ok === false, cheat.error);

R.section('leaving frees the seat and the room closes when empty');
const leftB = await emitAck(sockB, 'room:leave', {});
check('B left the room', leftB.ok);
await sleep(300);
const snapAfter = (await apiFetch('/api/rooms/' + roomId)).data;
check('B is no longer on seat 2', snapAfter.room.seats[1] === null);

await emitAck(sockA, 'room:leave', {});
await sleep(600);
const closed = await apiFetch('/api/rooms/' + roomId);
check('empty room closed automatically', closed.status === 404, 'HTTP ' + closed.status);

R.section('host controls');
const room2 = await createRoom(A.token, { title: 'Moderation room', category: 'chat' });
const s1 = await connect(A.token);
const s2 = await connect(B.token);
await emitAck(s1, 'room:join', { roomId: room2.room.id, seat: true });
await emitAck(s2, 'room:join', { roomId: room2.room.id, seat: true });

const lockRes = await emitAck(s1, 'seat:lock', { index: 3, locked: true });
check('host can lock an empty seat', lockRes.ok && lockRes.locked === true);

const lockDenied = await emitAck(s2, 'seat:lock', { index: 4, locked: true });
check('non-host cannot lock seats', lockDenied.ok === false, lockDenied.error);

const kickRes = await emitAck(s1, 'seat:kick', { userId: B.user.id, ban: false });
check('host can remove someone from the mic', kickRes.ok);

const endRes = await emitAck(s1, 'room:end', {});
check('host can end the room', endRes.ok);

R.section('account security: sessions & daily-bonus streak');
const { createRequire } = await import('node:module');
const bonusMod = createRequire(import.meta.url)('../server/bonus.js');
check('streak math: consecutive days escalate, gaps reset, caps at 7',
  bonusMod.streakFor(null, 100, 0).streak === 1
  && bonusMod.streakFor(99, 100, 3).streak === 4
  && bonusMod.streakFor(50, 100, 6).streak === 1
  && bonusMod.streakFor(100, 100, 5).claimed === true
  && bonusMod.streakFor(99, 100, 9).streak === 7,
  `day1=${bonusMod.awardFor(150, 1)} day7=${bonusMod.awardFor(150, 7)} coins`);

const E = await freshUser('Security');
const b1 = await apiFetch('/api/me/daily-bonus', { method: 'POST', token: E.token });
check('daily bonus claimed (streak day 1)', b1.ok && b1.data?.awarded === 150 && b1.data?.streak === 1,
  `+${b1.data?.awarded} 🪙 streak ${b1.data?.streak}`);
const b2 = await apiFetch('/api/me/daily-bonus', { method: 'POST', token: E.token });
check('daily bonus is once per day', b2.status === 400 && b2.data?.code === 'bonus_claimed', b2.data?.code);

const lo = await apiFetch('/api/auth/logout-all', { method: 'POST', token: E.token });
check('log out everywhere succeeds', lo.ok);
const deadTok = await apiFetch('/api/me', { token: E.token });
check('the old token is dead on every device', deadTok.status === 401, `HTTP ${deadTok.status}`);
const relog = await apiFetch('/api/auth/login', { method: 'POST', body: { username: E.user.username, password: 'test1234' } });
check('a fresh sign-in still works afterwards', relog.ok && !!relog.data?.token);

R.section('chat safety filter (server-side, bn + en + evasion)');
// fresh socket in a fresh room
const room3 = await createRoom(A.token, { title: 'Safety filter room', category: 'chat' });
const f1 = await connect(A.token);
await emitAck(f1, 'room:join', { roomId: room3.room.id });

// clean message passes before anything else
const stillOk = await emitAck(f1, 'chat:send', { body: 'chat still works fine 🙂' });
check('clean messages pass the filter', stillOk.ok, stillOk.error);

const profanityEn = await emitAck(f1, 'chat:send', { body: 'you are a fucking idiot' });
check('English profanity is rejected on the server', profanityEn.ok === false && profanityEn.code === 'chat_filtered',
  profanityEn.code || profanityEn.error);
const profanityBn = await emitAck(f1, 'chat:send', { body: 'তুমি একটা মাগি' });
check('Bengali profanity is rejected', profanityBn.ok === false && profanityBn.code === 'chat_filtered', profanityBn.code);
const evasion = await emitAck(f1, 'chat:send', { body: 'f.u.c.k you all' });
check('separator evasion (f.u.c.k) is caught', evasion.ok === false && evasion.code === 'chat_filtered', evasion.code);

// three strikes → the next (clean) message hits a temporary timeout
const afterStrikes = await emitAck(f1, 'chat:send', { body: 'totally clean words now' });
check('repeat offenders get a temporary chat timeout',
  afterStrikes.ok === false && afterStrikes.code === 'chat_timeout',
  afterStrikes.code + ' — ' + (afterStrikes.error || '').slice(0, 44));

// DM filter (socket), via the untouched user B
const f2 = await connect(B.token);
const dmBad = await emitAck(f2, 'dm:send', { toUserId: A.user.id, body: 'sh1t happens, magi' });
check('DM profanity is rejected', dmBad.ok === false && dmBad.code === 'chat_filtered', dmBad.code);

// room titles with profanity are refused (REST)
const badRoom = await apiFetch('/api/rooms', { method: 'POST', token: B.token, body: { title: 'khanki adda', category: 'party' } });
check('room titles with profanity are refused', badRoom.status === 400 && badRoom.data?.code === 'chat_filtered',
  `HTTP ${badRoom.status} ${badRoom.data?.code}`);

R.section('host analytics — the rooms I hosted');
const mrA = await apiFetch('/api/me/rooms', { token: A.token });
check('the host sees every room they opened', mrA.ok && mrA.data?.rooms?.length >= 3 && mrA.data?.summary?.totalRooms >= 3,
  `${mrA.data?.rooms?.length} rooms, ${mrA.data?.summary?.totalJoined} joins`);
check('per-room stats are real numbers and gift coins are tracked',
  mrA.data.rooms.every((r) => typeof r.totalJoined === 'number' && typeof r.peakUsers === 'number' && typeof r.giftCoins === 'number')
  && mrA.data.summary.giftCoins >= 100,
  `giftCoins ${mrA.data?.summary?.giftCoins} 🪙`);
const mrB = await apiFetch('/api/me/rooms', { token: B.token });
check('someone who never hosted sees none', mrB.ok && mrB.data?.rooms?.length === 0, `${mrB.data?.rooms?.length} rooms`);

f1.disconnect(); f2.disconnect();
s1.disconnect(); s2.disconnect(); sockA.disconnect(); sockB.disconnect();

process.exit(R.finish() ? 0 : 1);
