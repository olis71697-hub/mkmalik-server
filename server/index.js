'use strict';

/**
 * MK Malik — self-hosted live group voice chat server.
 *
 * One process serves:  REST API  +  Socket.IO realtime  +  WebRTC signalling
 *                      +  the web app itself (public/).
 *
 * Run:  node server/index.js      →  http://localhost:8080
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const express = require('express');
const { Server: SocketServer } = require('socket.io');

const config = require('./config');
const db = require('./db');
const { router: apiRouter } = require('./api');
const realtime = require('./realtime');
const state = require('./state');
const seed = require('./seed');

process.__startedAt = new Date().toISOString();

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// First boot: make sure the instance is never an empty shell.
// ---------------------------------------------------------------------------
try {
  const users = db.get('SELECT COUNT(*) c FROM users').c;
  if (users === 0) {
    console.log('[boot] empty database detected — running initial seed');
    seed();
  }
} catch (e) {
  console.error('[boot] seed failed:', e.message);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// CORS — the app is served from the same origin, but allow configured origins
// so the API can also back a native client.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allow = config.corsOrigins.includes('*') ? (origin || '*') : config.corsOrigins;
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', Array.isArray(allow) ? allow.join(',') : allow);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// The preview iframe must be embeddable.
app.use((_req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

app.use((req, _res, next) => {
  if (process.env.LOG_REQUESTS === '1') console.log(`${req.method} ${req.originalUrl}`);
  next();
});

// ---------------------------------------------------------------------------
// API + uploads + static web app
// ---------------------------------------------------------------------------
app.use('/api', apiRouter);
app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d', immutable: false }));

const PUBLIC_DIR = path.join(config.root, 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));

// health probe at the root level too (uptime monitors, load balancers)
app.get('/healthz', (_req, res) => res.json({ ok: true, up: Math.round(process.uptime()) }));

// SPA fallback — any non-API path renders the app shell.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(index)) return res.status(503).send('App shell missing (public/index.html)');
  res.sendFile(index);
});

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------
const io = new SocketServer(server, {
  cors: { origin: config.corsOrigins.includes('*') ? true : config.corsOrigins, credentials: true },
  maxHttpBufferSize: 1e6,
  pingInterval: 20_000,
  pingTimeout: 25_000,
  transports: ['websocket', 'polling'],
});
app.set('io', io);
realtime.mount(io);

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: err.message || 'Server error',
    code: err.code || (status === 500 ? 'server_error' : undefined),
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
server.listen(config.port, config.host, () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log('');
  console.log('  ███  MK MALIK — live voice rooms');
  console.log(`  ├─ local     http://localhost:${config.port}`);
  for (const ip of lan) console.log(`  ├─ network   http://${ip}:${config.port}`);
  console.log(`  ├─ seats     10 per room`);
  console.log(`  ├─ storage   ${config.dataDir}`);
  console.log(`  └─ env       ${config.env}  •  node ${process.version}`);
  console.log('');
});

// ---------------------------------------------------------------------------
// Graceful shutdown — never lose the room map on a restart.
// ---------------------------------------------------------------------------
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[shutdown] ${signal} — persisting ${state.roomCount()} live room(s)…`);
  try {
    for (const room of state.liveRooms()) {
      db.run('UPDATE rooms SET peak_users = MAX(peak_users, ?) WHERE id = ?', room.peakUsers, room.id);
    }
    db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) { console.error('[shutdown] persist failed:', e.message); }
  io.close();
  server.close(() => { console.log('[shutdown] bye'); process.exit(0); });
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

module.exports = { app, server, io };
