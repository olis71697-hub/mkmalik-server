/* REST client + session storage.
 *
 * Talks to the Node backend when one is reachable; otherwise it falls back to
 * the in-browser engine in local.js, so the same screens work either way.
 */

import { API_BASE, isLocal } from './runtime.js';
import { localApi } from './local.js';

const TOKEN_KEY = 'mkmalik.token';
const USER_KEY = 'mkmalik.user';

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
    res = await fetch(API_BASE + path, { method, headers, body: payload });
  } catch (_) {
    throw new ApiError('Network unreachable — check your connection', 'network', 0);
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

/** Route to the local engine when there is no backend behind us. */
const local = (name, ...args) => {
  const fn = localApi[name];
  if (!fn) throw new ApiError(`local mode does not implement ${name}`, 'not_implemented', 501);
  return fn.apply(localApi, args);
};

export const api = {
  // auth
  register: (username, password, displayName) =>
    isLocal() ? local('demo') : post('/auth/register', { username, password, displayName }),
  login: (username, password) =>
    isLocal() ? local('demo') : post('/auth/login', { username, password }),
  demo: () => (isLocal() ? local('demo') : post('/auth/demo')),

  me: () => (isLocal() ? local('me') : get('/me')),
  updateMe: (patchBody) => (isLocal() ? local('updateMe', patchBody) : patch('/me', patchBody)),
  uploadAvatar: (file) => {
    if (isLocal()) return local('uploadAvatar', file);
    const fd = new FormData();
    fd.append('image', file);
    return request('POST', '/me/avatar', fd);
  },
  dailyBonus: () => (isLocal() ? local('dailyBonus') : post('/me/daily-bonus')),

  // explore
  rooms: (params = {}) =>
    isLocal() ? local('rooms', params) : get('/rooms?' + new URLSearchParams(params)),
  room: (id) => (isLocal() ? local('room', id) : get('/rooms/' + id)),
  createRoom: (body) => (isLocal() ? local('createRoom', body) : post('/rooms', body)),

  // people
  search: (q) => (isLocal() ? local('search', q) : get('/search?q=' + encodeURIComponent(q))),
  user: (id) => (isLocal() ? local('user', id) : get('/users/' + id)),
  follow: (id) => (isLocal() ? local('follow', id) : post(`/users/${id}/follow`)),
  userGifts: (id) => (isLocal() ? local('userGifts', id) : get(`/users/${id}/gifts`)),

  // economy
  gifts: () => (isLocal() ? local('gifts') : get('/gifts')),
  topup: (amount, tok) => (isLocal() ? local('topup') : post('/wallet/topup', { amount, token: tok })),

  // moments
  moments: () => (isLocal() ? local('moments') : get('/moments')),
  postMoment: (formData) =>
    isLocal() ? local('postMoment', formData) : request('POST', '/moments', formData),
  likeMoment: (id) => (isLocal() ? local('likeMoment', id) : post(`/moments/${id}/like`)),
  momentComments: (id) => (isLocal() ? local('momentComments', id) : get(`/moments/${id}/comments`)),
  addComment: (id, body) =>
    isLocal() ? local('addComment', id, body) : post(`/moments/${id}/comments`, { body }),

  // chat
  conversations: () => (isLocal() ? local('conversations') : get('/chat/conversations')),
  thread: (userId, before) =>
    isLocal() ? local('thread', userId) : get(`/chat/${userId}/messages` + (before ? `?before=${before}` : '')),
  sendDM: (userId, body) =>
    isLocal() ? local('sendDM', userId, body) : post(`/chat/${userId}/messages`, { body }),

  // misc
  notifications: () => (isLocal() ? local('notifications') : get('/notifications')),
  readNotifications: () => (isLocal() ? local('readNotifications') : post('/notifications/read')),
  leaderboard: (period = 'day') =>
    isLocal() ? local('leaderboard', period) : get('/leaderboard?period=' + period),
  health: () => (isLocal() ? local('health') : get('/health')),
  iceServers: () => (isLocal() ? local('iceServers') : get('/ice-servers')),
};
