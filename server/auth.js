'use strict';

const jwt = require('jsonwebtoken');
const config = require('./config');
const { get } = require('./db');
const { unauthorized } = require('./util');

function sign(user) {
  return jwt.sign(
    { uid: user.id, un: user.username, r: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtTtl, issuer: 'panda-voice' }
  );
}

function verify(token) {
  return jwt.verify(token, config.jwtSecret, { issuer: 'panda-voice', ignoreExpiration: false });
}

function userFromToken(token) {
  let payload;
  try { payload = verify(token); } catch (_) { throw unauthorized('Session expired — please sign in again'); }
  const user = get('SELECT * FROM users WHERE id = ?', payload.uid);
  if (!user) throw unauthorized('Account not found');
  return user;
}

/** Express middleware — requires a valid bearer token. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  if (!token) return next(unauthorized());
  try {
    req.user = userFromToken(token);
    req.token = token;
    next();
  } catch (e) { next(e); }
}

/** Express middleware — attaches req.user when a token is present, else continues. */
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  if (token) {
    try { req.user = userFromToken(token); } catch (_) {}
  }
  next();
}

function requireAdmin(req, _res, next) {
  if (!req.user || req.user.role !== 'admin') return next(require('./util').forbidden('Admin only'));
  next();
}

module.exports = { sign, verify, userFromToken, requireAuth, optionalAuth, requireAdmin };
