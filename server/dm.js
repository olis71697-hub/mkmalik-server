'use strict';

/** Direct messages — 1:1 conversations between users. */

const { all, get, run } = require('./db');
const { uid, notFound, badRequest } = require('./util');
const { publicUser } = require('./state');

/** Deterministic conversation id so both directions map to one thread. */
function convIdFor(a, b) {
  return [a, b].sort().join('_');
}

function ensureConversation(aId, bId) {
  if (aId === bId) throw badRequest('Cannot message yourself');
  const [a, b] = [aId, bId].sort();
  const id = convIdFor(a, b);
  let conv = get('SELECT * FROM conversations WHERE id = ?', id);
  if (!conv) {
    run('INSERT INTO conversations (id, a_id, b_id, last_body, last_at) VALUES (?,?,?,?,?)', id, a, b, '', 0);
    conv = get('SELECT * FROM conversations WHERE id = ?', id);
  }
  return conv;
}

function sendDirect(fromUser, toUser, body) {
  const conv = ensureConversation(fromUser.id, toUser.id);
  const t = Date.now();
  const id = uid();
  run('INSERT INTO messages (id, conv_id, from_id, to_id, body, kind, created_at) VALUES (?,?,?,?,?,?,?)',
    id, conv.id, fromUser.id, toUser.id, body, 'text', t);

  const unreadCol = conv.a_id === toUser.id ? 'a_unread' : 'b_unread';
  run(`UPDATE conversations SET last_body = ?, last_at = ?, ${unreadCol} = ${unreadCol} + 1 WHERE id = ?`,
    body.slice(0, 120), t, conv.id);

  return {
    id, convId: conv.id, fromId: fromUser.id, toId: toUser.id,
    body, createdAt: t, readAt: 0, user: publicUser(fromUser),
  };
}

function listMessages(userId, otherId, { before = 0, limit = 50 } = {}) {
  const id = convIdFor(userId, otherId);
  const rows = all(
    `SELECT * FROM messages WHERE conv_id = ? AND (? = 0 OR created_at < ?)
     ORDER BY created_at DESC LIMIT ?`, id, before, before, Math.min(100, limit));
  return rows.reverse().map((m) => ({
    id: m.id, convId: m.conv_id, fromId: m.from_id, toId: m.to_id,
    body: m.body, createdAt: m.created_at, readAt: m.read_at,
  }));
}

function markRead(userId, otherId) {
  const conv = ensureConversation(userId, otherId);
  run('UPDATE messages SET read_at = ? WHERE conv_id = ? AND to_id = ? AND read_at = 0', Date.now(), conv.id, userId);
  const col = conv.a_id === userId ? 'a_unread' : 'b_unread';
  run(`UPDATE conversations SET ${col} = 0 WHERE id = ?`, conv.id);
  return true;
}

function listConversations(userId) {
  const rows = all(
    `SELECT * FROM conversations WHERE (a_id = ? OR b_id = ?) AND last_at > 0
     ORDER BY last_at DESC LIMIT 60`, userId, userId);
  return rows.map((c) => {
    const otherId = c.a_id === userId ? c.b_id : c.a_id;
    const other = get('SELECT * FROM users WHERE id = ?', otherId);
    return {
      id: c.id, other: publicUser(other), lastBody: c.last_body, lastAt: c.last_at,
      unread: c.a_id === userId ? c.a_unread : c.b_unread,
    };
  }).filter((c) => c.other);
}

module.exports = { ensureConversation, sendDirect, listMessages, markRead, listConversations, convIdFor };
