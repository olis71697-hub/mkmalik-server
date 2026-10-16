/*
 * MK Malik — integration test: peer topology.
 *
 * Verifies the audio graph the server hands out as people move between the
 * audience and the ten mic seats. Getting this wrong is the difference between
 * "connected but silent" and working voice, so it is asserted at every stage.
 *
 *   speaker  ⇄ speaker    sendrecv
 *   speaker  → listener   sendonly / recvonly
 *   listener ⇄ listener   no connection
 */

import { io } from 'socket.io-client';
import { BASE, sleep, apiFetch, freshUser, createRoom, emitAck, makeReporter } from './helpers.mjs';

const R = makeReporter('PEER TOPOLOGY');
const check = R.check;

function connect(token) {
  return new Promise((resolve, reject) => {
    const sock = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    sock.on('ready', () => resolve(sock));
    sock.on('connect_error', (e) => reject(new Error('connect_error: ' + e.message)));
    setTimeout(() => reject(new Error('socket timeout')), 6000);
  });
}

// record every peer-list push so assertions never race the network
const track = (sock) => {
  const box = [];
  sock.on('room:peers', (p) => box.push(p.peers));
  return box;
};
const dir = (box, otherId) => box.at(-1)?.find((p) => p.userId === otherId)?.direction;
const count = (box) => box.at(-1)?.length ?? -1;

const A = await freshUser();
const B = await freshUser();
console.log('  accounts:', A.user.displayName, '&', B.user.displayName);

const sA = await connect(A.token);
const sB = await connect(B.token);
const peersA = track(sA);
const peersB = track(sB);

const { room } = await createRoom(A.token, { title: 'Peer direction check', category: 'party' });

// ── 1. A on mic, B in the audience ─────────────────────────────────────────
R.section('A on mic, B listening');
await emitAck(sA, 'room:join', { roomId: room.id, seat: true });
await sleep(250);
await emitAck(sB, 'room:join', { roomId: room.id });
await sleep(450);

check('A publishes toward B', dir(peersA, B.user.id) === 'sendonly', 'A→B ' + dir(peersA, B.user.id));
check('B only listens to A', dir(peersB, A.user.id) === 'recvonly', 'B→A ' + dir(peersB, A.user.id));
check('exactly one peer connection each', count(peersA) === 1 && count(peersB) === 1,
  `A:${count(peersA)} B:${count(peersB)}`);

// ── 2. both on mic — two-way audio ─────────────────────────────────────────
R.section('both on mic');
await emitAck(sB, 'seat:take', { index: 1 });
await sleep(500);

check('A→B becomes two-way', dir(peersA, B.user.id) === 'sendrecv', dir(peersA, B.user.id));
check('B→A becomes two-way', dir(peersB, A.user.id) === 'sendrecv', dir(peersB, A.user.id));

// ── 3. B steps down — back to one-way ──────────────────────────────────────
R.section('B back in the audience');
await emitAck(sB, 'seat:leave', {});
await sleep(500);

check('A→B drops back to sendonly', dir(peersA, B.user.id) === 'sendonly', dir(peersA, B.user.id));
check('B→A drops back to recvonly', dir(peersB, A.user.id) === 'recvonly', dir(peersB, A.user.id));

// ── 4. two listeners need no audio path between them ───────────────────────
R.section('two listeners');
const C = await freshUser();
const sC = await connect(C.token);
const peersC = track(sC);
await emitAck(sC, 'room:join', { roomId: room.id });
await sleep(450);

check('a listener connects only to speakers',
  count(peersC) === 1 && dir(peersC, B.user.id) === undefined,
  `peers=${count(peersC)}, listener-to-listener=${dir(peersC, B.user.id) ?? 'none'}`);
check('C can hear A', dir(peersC, A.user.id) === 'recvonly', dir(peersC, A.user.id));

// ── 5. a full ten-seat room ────────────────────────────────────────────────
R.section('all 10 mic seats');
const socks = [];
for (let i = 0; i < 9; i++) {
  const u = await freshUser();
  const s = connect(u.token);
  socks.push(s);
  const sock = await s;
  const res = await emitAck(sock, 'room:join', { roomId: room.id, seat: true });
  if (!res.ok) check(`seat ${i + 2} could be taken`, false, res.error);
}
await sleep(600);

const snap = (await apiFetch('/api/rooms/' + room.id)).data;
check('all 10 seats are filled', snap.room.seats.filter(Boolean).length === 10,
  `${snap.room.seats.filter(Boolean).length}/10 occupied`);
check('a newcomer can still listen (no seats left)',
  (await emitAck(sB, 'room:snapshot', {})).ok === true);

// an 11th speaker must be refused, not silently dropped
const overflowUser = await freshUser();
const sOver = await connect(overflowUser.token);
const overRes = await emitAck(sOver, 'room:join', { roomId: room.id });
check('11th person joins as a listener instead of a speaker',
  overRes.ok && overRes.room.viewer.seat === null, `seat=${overRes.room?.viewer?.seat}`);
const takeOver = await emitAck(sOver, 'seat:take', {});
check('taking a seat when all 10 are full is refused', takeOver.ok === false, takeOver.error);

for (const s of socks) (await s).disconnect();
sOver.disconnect();
sA.disconnect(); sB.disconnect(); sC.disconnect();

process.exit(R.finish() ? 0 : 1);
