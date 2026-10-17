/*
 * Panda Voice — integration test: Web Push (VAPID) notifications.
 *
 * The server owns a real VAPID keypair (auto-generated once, stored in
 * data/.vapid.json), browsers register through the Push API, and gifts /
 * followers / DMs reach people even with the app closed.
 *
 * What can be verified here: key generation + persistence, subscribe /
 * unsubscribe storage, dedupe, the settings toggle UI, the service-worker
 * push handler, and that delivery attempts answer honestly. The final hop
 * (server → fcm.googleapis.com → device) needs a deployed server with
 * outbound internet; this sandbox has none, so /push/test must return a
 * structured "unreachable" answer instead of hanging or lying.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, apiFetch, freshUser, sleep } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', 'public');
const r = makeReporter('web push · VAPID notifications');

// ── the server advertises push support ─────────────────────────────────────
r.section('server side');
const health = (await apiFetch('/api/health')).data;
r.check('health reports push as configured', health?.features?.push === true,
  `features.push = ${health?.features?.push}`);

const key1 = (await apiFetch('/api/push/key')).data?.publicKey;
r.check('a public VAPID key is served', typeof key1 === 'string' && key1.length > 60,
  key1 ? `${key1.slice(0, 16)}… (${key1.length} chars)` : 'none');
const key2 = (await apiFetch('/api/push/key')).data?.publicKey;
r.check('the keypair is stable (persisted, not regenerated)', key1 === key2);

// ── a browser registers ────────────────────────────────────────────────────
r.section('subscribe / unsubscribe');
const user = await freshUser('Push Tester');
const endpoint = `https://fcm.googleapis.com/fcm/send/push-${Date.now().toString(36)}`;
const sub = {
  endpoint,
  keys: { p256dh: 'BEl62iUYgU34xkuCGKgBLBmTXXlzV0d82LVZAh1Yy7O5oywGpCbSGvnxCofEzJmF3qLvlJ0fAS9GszWhVqbclAA', auth: 'e2xVf5aJmYIqcFnHSO9Lyw' },
};

let res = await apiFetch('/api/push/subscribe', { method: 'POST', token: user.token, body: sub });
r.check('subscribe accepts a PushSubscription', res.ok && res.data?.ok === true && res.data?.enabled === true,
  `count=${res.data?.count}`);

res = await apiFetch('/api/push/status', { token: user.token });
r.check('status shows this browser registered', res.data?.enabled === true && res.data?.count === 1);

// re-subscribing the same browser must not duplicate the row
res = await apiFetch('/api/push/subscribe', { method: 'POST', token: user.token, body: sub });
r.check('re-subscribing the same endpoint does not duplicate', res.data?.count === 1, `count=${res.data?.count}`);

res = await apiFetch('/api/push/subscribe', {
  method: 'POST', token: user.token,
  body: { endpoint: 'https://fcm.googleapis.com/fcm/send/other', keys: { p256dh: 'x', auth: 'y' } },
});
r.check('a second browser can also register', res.data?.count === 2, `count=${res.data?.count}`);

res = await apiFetch('/api/push/unsubscribe', { method: 'POST', token: user.token, body: { endpoint } });
r.check('unsubscribe removes just that browser', res.ok && res.data?.count === 1, `count=${res.data?.count}`);

// security: someone else's token cannot read or change my subscriptions
const other = await freshUser('Push Stranger');
res = await apiFetch('/api/push/status', { token: other.token });
r.check('another user sees their own (empty) subscriptions', res.data?.enabled === false && res.data?.count === 0);
res = await apiFetch('/api/push/subscribe', { method: 'POST', body: sub });  // no token at all
r.check('subscribe requires authentication', res.status === 401, `HTTP ${res.status}`);

// ── delivery is attempted honestly ─────────────────────────────────────────
r.section('delivery');
res = await apiFetch('/api/push/test', { method: 'POST', token: other.token });
r.check('test push with no subscription says so', res.ok && res.data?.ok === false && res.data?.skipped === 'no_subscription',
  res.data?.skipped);

// freshUser is online over REST only (no socket), so the remaining browser of
// "Push Tester" is eligible for delivery — which will fail without outbound
// internet, and must answer honestly rather than claim success.
res = await apiFetch('/api/push/test', { method: 'POST', token: user.token, maxWaitMs: 30_000 });
r.check('test push answers with a structured result',
  res.ok && typeof res.data?.ok === 'boolean' && (res.data.ok || res.data.error),
  res.data?.ok ? `sent=${res.data.sent}` : (res.data?.error || '').slice(0, 60));

// ── followed host goes live → notification + push attempt ──────────────────
r.section('gone-live notifications');
const host = await freshUser('Live Host');
const fan = await freshUser('Fan');
const bystander = await freshUser('Bystander');
await apiFetch(`/api/users/${host.user.id}/follow`, { method: 'POST', token: fan.token });

const created = await apiFetch('/api/rooms', {
  method: 'POST', token: host.token,
  body: { title: 'Fan notification test room', category: 'party' },
});
r.check('the host created a room', !!created.data?.room?.id, created.data?.room?.id);

const fanNotifs = (await apiFetch('/api/notifications', { token: fan.token })).data?.notifications || [];
const liveNotif = fanNotifs.find((n) => n.kind === 'live' && n.meta?.roomId === created.data.room.id);
r.check('the follower received a gone-live notification', !!liveNotif,
  liveNotif ? `${liveNotif.title} → ${liveNotif.meta.roomId}` : 'none');

const byNotifs = (await apiFetch('/api/notifications', { token: bystander.token })).data?.notifications || [];
r.check('non-followers are not notified', !byNotifs.some((n) => n.kind === 'live'));

const priv = await apiFetch('/api/rooms', {
  method: 'POST', token: host.token,
  body: { title: 'Secret room', category: 'party', isPrivate: true },
});
const fanAfter = (await apiFetch('/api/notifications', { token: fan.token })).data?.notifications || [];
r.check('private rooms do not announce themselves',
  !!priv.data?.room?.id && !fanAfter.some((n) => n.kind === 'live' && n.meta?.roomId === priv.data.room.id));

// ── the client side really wires the Push API ──────────────────────────────
r.section('client side');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
r.check('service worker handles push events', /addEventListener\('push'/.test(sw) && /showNotification/.test(sw));
r.check('service worker handles notification clicks', /addEventListener\('notificationclick'/.test(sw));

const extra = fs.readFileSync(path.join(ROOT, 'js/screens/extra.js'), 'utf8');
r.check('settings has a real push toggle (Push API subscribe flow)',
  /pushManager\.subscribe/.test(extra) && /pushKey\(\)/.test(extra) && /পুশ নোটিফিকেশন/.test(extra));

const apiJs = fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8');
r.check('client talks to the push endpoints', /\/push\/key/.test(apiJs) && /\/push\/subscribe/.test(apiJs));

const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
r.check('a notification deep link (#room=) opens the room', /#room=/.test(appJs) && /openRoom\(App, roomId\)/.test(appJs));
r.check('notification rows with a roomId are clickable', /meta\?\.roomId/.test(extra));

const serverPush = fs.readFileSync(path.resolve(here, '..', 'server/push.js'), 'utf8');
r.check('server prunes dead endpoints (410/404)', /410/.test(serverPush) && /404/.test(serverPush));
r.check('server skips push when the user is online', /connected/.test(serverPush) && /skipped: 'online'/.test(serverPush));

await sleep(50);
process.exit(r.finish() ? 0 : 1);
