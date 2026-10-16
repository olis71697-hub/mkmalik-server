/*
 * MK Malik — integration test.
 * Start the server first (npm start), then:  npm test
 * Override the target with BASE_URL=http://host:port
 */
/* Focused check: peer directions flip correctly through a seat change. */
import { io } from 'socket.io-client';
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (u) => (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: 'demo1234' }) })).json();
const connect = (t) => new Promise((res, rej) => {
  const s = io(BASE, { auth: { token: t }, transports: ['websocket'], reconnection: false });
  s.on('ready', () => res(s)); s.on('connect_error', rej);
});
// capture EVERY room:peers payload for a socket
const trackPeers = (sock) => { const box = []; sock.on('room:peers', (p) => box.push(p.peers)); return box; };
const ack = (s, e, p = {}) => new Promise((r) => { s.emit(e, p, r); setTimeout(() => r({ ok: false }), 4000); });

const A = await login('mkmalik'), B = await login('rafi');
const sA = await connect(A.token), sB = await connect(B.token);
const peersA = trackPeers(sA), peersB = trackPeers(sB);

const room = (await (await fetch(BASE + '/api/rooms', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + A.token },
  body: JSON.stringify({ title: 'Peer direction check', category: 'party' }) })).json()).room.id;

await ack(sA, 'room:join', { roomId: room, seat: true });
await sleep(200);
await ack(sB, 'room:join', { roomId: room });
await sleep(400);

const dir = (box, otherId) => box.at(-1)?.find((p) => p.userId === otherId)?.direction;

console.log('phase 1 — A on mic, B listening');
console.log('  A→B :', dir(peersA, B.user.id), '(expect sendonly — A publishes)');
console.log('  B→A :', dir(peersB, A.user.id), '(expect recvonly — B listens)');

await ack(sB, 'seat:take', { index: 1 });
await sleep(500);

console.log('phase 2 — both on mic');
console.log('  A→B :', dir(peersA, B.user.id), '(expect sendrecv)');
console.log('  B→A :', dir(peersB, A.user.id), '(expect sendrecv)');

await ack(sB, 'seat:leave', {});
await sleep(500);

console.log('phase 3 — B back to the audience');
console.log('  A→B :', dir(peersA, B.user.id), '(expect sendonly)');
console.log('  B→A :', dir(peersB, A.user.id), '(expect recvonly)');

const ok = dir(peersA, B.user.id) === 'sendonly'
  && dir(peersB, A.user.id) === 'recvonly'
  && peersA.at(-1).length === 1 && peersB.at(-1).length === 1;

console.log('\n' + (ok ? '✅ peer topology correct at every stage' : '❌ topology wrong'));
sA.disconnect(); sB.disconnect();
process.exit(ok ? 0 : 1);
