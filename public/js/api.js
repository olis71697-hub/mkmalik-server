/* REST client + session storage.
 *
 * Every call goes to the real Node backend (same origin, or a discovered
 * backend origin). There is no offline mock: if the server is unreachable the
 * app shows an error screen instead of pretending to work.
 */

import { apiBase } from './runtime.js';

const TOKEN_KEY = 'panda.token';
const USER_KEY = 'panda.user';

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch (_) {}

export const session = {
  get token() { return token; },
  set(nextToken, user) {
    token = nextToken;
    try {
      if (nextToken) localStorage.setItem(TOKEN_KEY, nextToken);
      else localStorage.removeItem(TOKEN_KEY);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
      else localStorage.removeItem(USER_KEY);
    } catch (_) {}
  },
  cachedUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (_) { return null; }
  },
  clear() { this.set(null, null); },
};

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(apiBase() + path, { method, headers, body: payload });
  } catch (_) {
    throw new ApiError('নেটওয়ার্কে পৌঁছানো যাচ্ছে না — সংযোগ দেখুন', 'network', 0);
  }

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (_) { data = { raw: text }; } }

  if (!res.ok) {
    const err = new ApiError((data && data.error) || `Request failed (${res.status})`, data?.code, res.status);
    if (res.status === 401) session.clear();
    throw err;
  }
  return data;
}

const get   = (p)    => request('GET', p);
const post  = (p, b) => request('POST', p, b);
const patch = (p, b) => request('PATCH', p, b);
const put   = (p, b) => request('PUT', p, b);
const del   = (p, b) => request('DELETE', p, b);

/** query string that skips undefined/null/empty values */
function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, v);
  }
  return sp.toString();
}

export const api = {
  // ---- auth (username / password) ----
  register: (username, password, displayName, accepted) =>
    post('/auth/register', { username, password, displayName, accepted }),
  login: (username, password) => post('/auth/login', { username, password }),

  // ---- auth (phone OTP) ----
  otpRequest: (phone) => post('/auth/otp/request', { phone }),
  otpVerify: (phone, code, displayName) => post('/auth/otp/verify', { phone, code, displayName }),

  // ---- auth (Google) ----
  google: (credential) => post('/auth/google', { credential }),

  // ---- auth (password reset) ----
  forgot: (username) => post('/auth/forgot', { username }),
  reset: (username, code, password) => post('/auth/reset', { username, code, password }),

  // ---- me ----
  me: () => get('/me'),
  updateMe: (patchBody) => patch('/me', patchBody),
  uploadAvatar: (file) => {
    const fd = new FormData();
    fd.append('image', file);
    return request('POST', '/me/avatar', fd);
  },
  dailyBonus: () => post('/me/daily-bonus'),
  changePassword: (currentPassword, newPassword) => post('/me/password', { currentPassword, newPassword }),
  deleteAccount: (body) => del('/me', body),

  // ---- settings ----
  settings: () => get('/me/settings'),
  saveSettings: (s) => put('/me/settings', s),

  // ---- web push ----
  pushKey: () => get('/push/key'),
  pushStatus: () => get('/push/status'),
  pushSubscribe: (subscription) => post('/push/subscribe', subscription),
  pushUnsubscribe: (endpoint) => post('/push/unsubscribe', { endpoint }),
  pushTest: () => post('/push/test'),

  // ---- blocks / reports ----
  blocks: () => get('/me/blocks'),
  block: (id) => post(`/users/${id}/block`),
  unblock: (id) => del(`/users/${id}/block`),
  report: (body) => post('/report', body),

  // ---- explore ----
  rooms: (params = {}) => get('/rooms?' + qs(params)),
  room: (id) => get('/rooms/' + id),
  createRoom: (body) => post('/rooms', body),

  // ---- people ----
  search: (q) => get('/search?q=' + encodeURIComponent(q)),
  users: (sort = 'popular') => get('/users?sort=' + sort),
  user: (id) => get('/users/' + id),
  follow: (id) => post(`/users/${id}/follow`),
  followers: (id) => get(`/users/${id}/followers`),
  following: (id) => get(`/users/${id}/following`),
  userGifts: (id) => get(`/users/${id}/gifts`),

  // ---- economy ----
  gifts: () => get('/gifts'),
  topup: (amount, tok) => post('/wallet/topup', { amount, token: tok }),

  // ---- wallet ----
  wallet: () => get('/wallet'),
  packages: () => get('/wallet/packages'),
  purchase: (packageId, paymentMethod, paymentRef) =>
    post('/wallet/purchase', { packageId, paymentMethod, paymentRef }),

  // ---- moments (API kept) ----
  moments: () => get('/moments'),

  // ---- chat ----
  conversations: () => get('/chat/conversations'),
  thread: (userId, before) => get(`/chat/${userId}/messages` + (before ? `?before=${before}` : '')),
  sendDM: (userId, body) => post(`/chat/${userId}/messages`, { body }),

  // ---- misc ----
  notifications: () => get('/notifications'),
  readNotifications: () => post('/notifications/read'),
  leaderboard: (period = 'day') => get('/leaderboard?period=' + period),
  health: () => get('/health'),
  iceServers: () => get('/ice-servers'),
};
