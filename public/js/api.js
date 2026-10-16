/* REST client + session storage. */

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

async function request(method, path, body, opts = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: payload });
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

const get   = (p)       => request('GET', p);
const post  = (p, b)    => request('POST', p, b);
const patch = (p, b)    => request('PATCH', p, b);
const del   = (p)       => request('DELETE', p);

export const api = {
  // auth
  register: (username, password, displayName) => post('/auth/register', { username, password, displayName }),
  login:    (username, password)              => post('/auth/login', { username, password }),
  me:       ()                                => get('/me'),
  updateMe: (patchBody)                       => patch('/me', patchBody),
  uploadAvatar: (file) => {
    const fd = new FormData();
    fd.append('image', file);
    return request('POST', '/me/avatar', fd);
  },
  dailyBonus: () => post('/me/daily-bonus'),

  // explore
  rooms:  (params = {}) => get('/rooms?' + new URLSearchParams(params)),
  room:   (id)          => get('/rooms/' + id),
  createRoom: (body)    => post('/rooms', body),

  // people
  search: (q)      => get('/search?q=' + encodeURIComponent(q)),
  user:   (id)     => get('/users/' + id),
  follow: (id)     => post(`/users/${id}/follow`),
  userGifts: (id)  => get(`/users/${id}/gifts`),

  // economy
  gifts:  ()        => get('/gifts'),
  topup:  (amount, tok) => post('/wallet/topup', { amount, token: tok }),

  // moments
  moments:        ()            => get('/moments'),
  postMoment:     (formData)    => request('POST', '/moments', formData),
  likeMoment:     (id)          => post(`/moments/${id}/like`),
  momentComments: (id)          => get(`/moments/${id}/comments`),
  addComment:     (id, body)    => post(`/moments/${id}/comments`, { body }),

  // chat
  conversations: ()            => get('/chat/conversations'),
  thread:        (userId, before) => get(`/chat/${userId}/messages` + (before ? `?before=${before}` : '')),
  sendDM:        (userId, body)   => post(`/chat/${userId}/messages`, { body }),

  // misc
  notifications: () => get('/notifications'),
  readNotifications: () => post('/notifications/read'),
  leaderboard: (period = 'day') => get('/leaderboard?period=' + period),
  health: () => get('/health'),
};
