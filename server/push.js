'use strict';

/**
 * Panda Voice — Web Push notifications (VAPID).
 *
 * Real, standards-based push: the server owns a VAPID keypair (generated once,
 * stored in data/.vapid.json), browsers register through the Push API, and
 * events (gifts, followers, DMs) are delivered even when the app is closed.
 *
 * No third-party service is required — delivery goes straight to the browser
 * push services (fcm.googleapis.com on Android/Chrome, apple push on iOS
 * installed-PWAs). The server must simply be able to reach the internet.
 */

const webpush = require('web-push');
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, uid } = require('./db');

const FILE = path.join(__dirname, '..', 'data', '.vapid.json');
let vapid = null;

/** Load (or generate once) the VAPID keypair and configure web-push. */
function init() {
  if (vapid) return vapid;
  try {
    vapid = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!vapid.publicKey || !vapid.privateKey) throw new Error('incomplete key file');
  } catch (_) {
    const keys = webpush.generateVAPIDKeys();
    vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:admin@panda-voice.app' };
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(vapid, null, 2) + '\n');
      console.log('[push] generated new VAPID keypair → data/.vapid.json');
    } catch (e) {
      console.error('[push] could not persist VAPID keys:', e.message);
    }
  }
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return vapid;
}

/** Public half — the browser needs it to subscribe. */
function publicKey() { return init().publicKey; }

/** True once a keypair exists. */
function configured() {
  try { init(); return !!vapid.publicKey; } catch (_) { return false; }
}

/** Store (or refresh) a browser subscription for this user. */
function subscribe(userId, sub) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!/^https?:\/\//.test(endpoint) || !p256dh || !auth) {
    const e = new Error('Invalid push subscription');
    e.status = 400;
    throw e;
  }
  init();
  run(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    uid(), userId, endpoint, p256dh, auth, Date.now());
}

/** Drop one of this user's subscriptions (browser unsubscribed / toggle off). */
function unsubscribe(userId, endpoint) {
  run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, String(endpoint || ''));
}

/** Does this user have any registered browser? */
function status(userId) {
  const rows = all('SELECT endpoint FROM push_subscriptions WHERE user_id = ?', userId);
  return { enabled: rows.length > 0, count: rows.length };
}

/** The per-kind toggles from user_settings (default: on). */
function wantsPush(userId, kind) {
  const col = { follow: 'notify_follow', gift: 'notify_gift', dm: 'notify_message', message: 'notify_message' }[kind];
  if (!col) return true;
  try {
    const s = get(`SELECT ${col} AS v FROM user_settings WHERE user_id = ?`, userId);
    return !s || s.v === null || s.v === undefined ? true : !!s.v;
  } catch (_) { return true; }
}

/** Never let a slow/unreachable push service hold a request hostage. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('push timeout')), ms)),
  ]);
}

/**
 * Deliver a push to every browser of this user.
 * Skips when the user is online (the socket event already reached them) or has
 * the notification kind turned off. Dead endpoints (410/404) are pruned.
 *
 * @returns {{sent:number, skipped?:string, error?:string}}
 */
async function sendToUser(userId, payload) {
  const kind = payload?.kind || 'general';
  if (!wantsPush(userId, kind)) return { sent: 0, skipped: 'settings' };

  try {
    const rt = require('./realtime');           // lazy: realtime requires push too
    if (rt.connected && rt.connected.has(userId)) return { sent: 0, skipped: 'online' };
  } catch (_) { /* realtime not mounted — just send */ }

  const rows = all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  if (!rows.length) return { sent: 0, skipped: 'no_subscription' };

  init();
  let sent = 0;
  const dead = [];

  await Promise.all(rows.map(async (row) => {
    try {
      await withTimeout(webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload),
      ), 5000);
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(row.endpoint);
    }
  }));

  for (const ep of dead) run('DELETE FROM push_subscriptions WHERE endpoint = ?', ep);
  return dead.length === rows.length && sent === 0
    ? { sent: 0, error: 'push service unreachable from this server' }
    : { sent };
}

module.exports = { init, publicKey, configured, subscribe, unsubscribe, status, sendToUser };
