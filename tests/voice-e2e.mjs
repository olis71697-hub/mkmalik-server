/*
 * MK Malik — integration test.
 * Start the server first (npm start), then:  npm test
 * Override the target with BASE_URL=http://host:port
 */
/* End-to-end: two real clients, one room, real WebRTC signalling relay. */
import { io } from 'socket.io-client';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'demo1234' }),
  });
  return res.json();
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const sock = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    sock.on('ready', () => resolve(sock));
    sock.on('connect_error', (e) => reject(new Error('connect_error: ' + e.message)));
    setTimeout(() => reject(new Error('socket timeout')), 6000);
  });
}

const emitAck = (sock, evt, payload = {}) =>
  new Promise((resolve) => {
    sock.emit(evt, payload, resolve);
    setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), 5000);
  });

console.log('\n════ LIVE VOICE ROOM — END TO END ════\n');

// ── sign in two different people ───────────────────────────────────────────
const A = await login('mkmalik');
const B = await login('aylin');
console.log('  users:', A.user.displayName, '&', B.user.displayName);

const sockA = await connect(A.token);
const sockB = await connect(B.token);
// record every peer-list push so assertions never race the network
const peersBoxA = [], peersBoxB = [];
sockA.on('room:peers', (p) => peersBoxA.push(p.peers));
sockB.on('room:peers', (p) => peersBoxB.push(p.peers));
const lastDir = (box, otherId) => box.at(-1)?.find((p) => p.userId === otherId)?.direction;
check('both clients authenticated over websocket', !!sockA.id && !!sockB.id, `${sockA.id.slice(0,6)} / ${sockB.id.slice(0,6)}`);

// ── A opens a room ─────────────────────────────────────────────────────────
const created = await (await fetch(BASE + '/api/rooms', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + A.token },
  body: JSON.stringify({ title: 'Voice test room', category: 'party', tags: ['test'] }),
})).json();
const roomId = created.room.id;
check('room created', !!roomId, created.room.title);

// ── A joins and takes seat 1 ───────────────────────────────────────────────
const joinA = await emitAck(sockA, 'room:join', { roomId, seat: true });
check('A joined + auto-seated', joinA.ok && joinA.room.viewer.seat === 0, `seat ${joinA.room?.viewer?.seat}`);

// ── B joins as a listener ──────────────────────────────────────────────────
const joinB = await emitAck(sockB, 'room:join', { roomId });
check('B joined as listener', joinB.ok && joinB.room.viewer.seat === null);
check('B sees A on mic seat 1', joinB.room.seats[0]?.userId === A.user.id);
check('B got a peer to listen to (A)', joinB.peers.some((p) => p.userId === A.user.id),
  JSON.stringify(joinB.peers));

const bPeerToA = joinB.peers.find((p) => p.userId === A.user.id);
check('listener direction is recvonly', bPeerToA?.direction === 'recvonly', bPeerToA?.direction);

// ── A should learn about B (speaker publishes to listener) ─────────────────
await sleep(400);
check('A was told to publish toward B',
  ['sendonly', 'sendrecv'].includes(lastDir(peersBoxA, B.user.id)),
  'A→B ' + lastDir(peersBoxA, B.user.id));

// ── WebRTC signalling relay, both directions ───────────────────────────────
console.log('\n  — signalling relay —');
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
const C = await login('kenji');
const sockC = await connect(C.token);
let injected = false;
sockC.once('rtc:signal', () => { injected = true; });
sockC.emit('rtc:signal', { to: B.user.id, data: { type: 'description', description: { type: 'offer', sdp: 'evil' } } });
await sleep(500);
check('outsider cannot inject signalling', !injected);
sockC.disconnect();

// ── B takes seat 2 → both become speakers, direction flips to sendrecv ─────
console.log('\n  — seat changes —');
const seatB = await emitAck(sockB, 'seat:take', { index: 1 });
check('B took mic seat 2', seatB.ok && seatB.seat === 1);

await sleep(400);
check('speaker↔speaker becomes sendrecv',
  lastDir(peersBoxB, A.user.id) === 'sendrecv' && lastDir(peersBoxA, B.user.id) === 'sendrecv',
  `A→B ${lastDir(peersBoxA, B.user.id)}, B→A ${lastDir(peersBoxB, A.user.id)}`);

// ── mute state ─────────────────────────────────────────────────────────────
const muteRes = await emitAck(sockB, 'seat:mute', { muted: true });
check('mic mute acknowledged', muteRes.ok && muteRes.muted === true);

// ── chat in the room ───────────────────────────────────────────────────────
console.log('\n  — room chat —');
const chatGot = new Promise((resolve) => sockB.once('room:message', resolve));
const chatSent = await emitAck(sockA, 'chat:send', { body: 'Hello from the test 👋' });
const chatMsg = await Promise.race([chatGot, sleep(3000).then(() => null)]);
check('message broadcast to the other person', chatMsg?.body === 'Hello from the test 👋', chatMsg?.user?.displayName);

// ── gifts move coins, server-side ──────────────────────────────────────────
console.log('\n  — gift economy —');
const beforeA = (await (await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + A.token } })).json()).user.coins;
const beforeB = (await (await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + B.token } })).json()).user.diamonds;

const giftFx = new Promise((resolve) => sockB.once('room:gift', resolve));
const giftRes = await emitAck(sockA, 'gift:send', { giftId: 'rose', toUserId: B.user.id, qty: 5 });
const fx = await Promise.race([giftFx, sleep(3000).then(() => null)]);
check('gift accepted', giftRes.ok, `rose ×5 = ${giftRes.event?.coins} coins`);
check('gift broadcast for the animation', fx?.gift?.emoji === '🌹' && fx?.qty === 5);

const afterA = (await (await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + A.token } })).json()).user.coins;
const afterB = (await (await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + B.token } })).json()).user.diamonds;
check('sender coins deducted', beforeA - afterA === 50, `${beforeA} → ${afterA}`);
check('receiver diamonds credited', afterB - beforeB === 50, `${beforeB} → ${afterB}`);

// client may not mint coins
const cheat = await emitAck(sockA, 'gift:send', { giftId: 'dragon', toUserId: B.user.id, qty: 99 });
check('unaffordable gift is rejected by the server', cheat.ok === false, cheat.error);

// ── leaving frees the seat and the room closes when empty ─────────────────
console.log('\n  — lifecycle —');
const leftB = await emitAck(sockB, 'room:leave', {});
check('B left the room', leftB.ok);
await sleep(300);
const snapAfter = await (await fetch(BASE + '/api/rooms/' + roomId)).json();
check('B is no longer on seat 2', snapAfter.room.seats[1] === null);

await emitAck(sockA, 'room:leave', {});
await sleep(600);
const closed = await fetch(BASE + '/api/rooms/' + roomId);
check('empty room closed automatically', closed.status === 404, 'HTTP ' + closed.status);

// ── host controls ──────────────────────────────────────────────────────────
console.log('\n  — host controls —');
const room2 = await (await fetch(BASE + '/api/rooms', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + A.token },
  body: JSON.stringify({ title: 'Moderation room', category: 'chat' }),
})).json();
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

s1.disconnect(); s2.disconnect(); sockA.disconnect(); sockB.disconnect();

console.log(`\n════ RESULT: ${pass} passed, ${fail} failed ════\n`);
process.exit(fail ? 1 : 0);
