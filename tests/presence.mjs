/*
 * MK Malik — integration test: presence.
 *
 * A phone that backgrounds the app has its timers throttled or suspended, so
 * heartbeat pings stop arriving. That must NOT cost the user their mic seat:
 * a still-connected socket is proof of presence. This test deliberately sends
 * no heartbeats and waits past the ghost timeout.
 */

import { io } from 'socket.io-client';
import { BASE, sleep, apiFetch, freshUser, createRoom, emitAck, makeReporter } from './helpers.mjs';

const R = makeReporter('PRESENCE / GHOST SWEEPING');
const check = R.check;

function connect(token) {
  return new Promise((resolve, reject) => {
    const sock = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    sock.on('ready', () => resolve(sock));
    sock.on('connect_error', (e) => reject(new Error('connect_error: ' + e.message)));
    setTimeout(() => reject(new Error('socket timeout')), 6000);
  });
}

const A = await freshUser();
const B = await freshUser();
console.log('  accounts:', A.user.displayName, '&', B.user.displayName);

const sA = await connect(A.token);
const sB = await connect(B.token);
const { room } = await createRoom(A.token, { title: 'Presence check', category: 'chat' });

await emitAck(sA, 'room:join', { roomId: room.id, seat: true });
await emitAck(sB, 'room:join', { roomId: room.id, seat: true });
await sleep(400);

const at = async () => (await apiFetch('/api/rooms/' + room.id)).data?.room;
let snap = await at();
check('both speakers are on mic', snap?.seats?.[0]?.userId === A.user.id && snap?.seats?.[1]?.userId === B.user.id,
  `seats 1&2 occupied`);

// The ghost timeout is 45s and the sweeper runs every 15s. Wait long enough for
// several sweeps to happen with zero heartbeats sent.
const WAIT_MS = 62_000;
console.log(`  … idling ${Math.round(WAIT_MS / 1000)}s with no heartbeats (simulating a backgrounded phone)`);
await sleep(WAIT_MS);

snap = await at();
check('room is still open after the ghost timeout', !!snap);
check('A kept mic seat 1 without any heartbeat', snap?.seats?.[0]?.userId === A.user.id,
  snap?.seats?.[0]?.user?.displayName ?? 'seat empty');
check('B kept mic seat 2 without any heartbeat', snap?.seats?.[1]?.userId === B.user.id,
  snap?.seats?.[1]?.user?.displayName ?? 'seat empty');

// Real disconnects must still be cleaned up promptly.
const sC = await connect((await freshUser()).token);
const cUser = await freshUser();
const sC2 = await connect(cUser.token);
await emitAck(sC2, 'room:join', { roomId: room.id, seat: true });
await sleep(400);
snap = await at();
check('a third speaker joined seat 3', snap?.seats?.[2]?.userId === cUser.user.id);

sC2.disconnect();           // clean disconnect
await sleep(1200);
snap = await at();
check('disconnected speaker frees the seat immediately', snap?.seats?.[2] === null,
  snap?.seats?.[2] ? 'still occupied' : 'seat 3 free');

// An abandoned room (no sockets at all) still closes on its own.
sA.disconnect(); sB.disconnect(); sC.disconnect();
await sleep(1500);
const ownersLeft = await at();
check('room closes once every socket has gone', !ownersLeft, ownersLeft ? 'still open' : 'closed');

process.exit(R.finish() ? 0 : 1);
