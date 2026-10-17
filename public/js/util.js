/* Panda Voice — shared helpers: DOM, formatting, icons, procedural covers. */

// ── DOM ────────────────────────────────────────────────────────────────────
export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Inline SVG icon from a path spec. */
export function svg(paths, { width = 24, height = 24, cls = '' } = {}) {
  const p = Array.isArray(paths) ? paths : [paths];
  return `<svg viewBox="0 0 24 24" class="${cls}" width="${width}" height="${height}" fill="none"
    stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${p.join('')}</svg>`;
}

export const ICON = {
  mic:    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  micOff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="m4 4 16 16"/>',
  lock:   '<rect x="5" y="11" width="14" height="9" rx="2.4"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2.4"/><path d="M8.5 11V8a3.5 3.5 0 0 1 6.9-.9"/>',
  user:   '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users:  '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.4a3.4 3.4 0 0 1 0 6.6"/><path d="M17.5 14.4A6.5 6.5 0 0 1 21.5 20"/>',
  hand:   '<path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 10.5V6a1.5 1.5 0 0 1 3 0v9a6 6 0 0 1-6 6h-1a6 6 0 0 1-5.2-3L4 15.5a1.6 1.6 0 0 1 2.6-1.8L8 15"/>',
  gift:   '<path d="M4 11h16v9H4z"/><path d="M3 7h18v4H3z"/><path d="M12 7v13"/><path d="M12 7S10.5 3 8 3a2.5 2.5 0 0 0 0 4"/><path d="M12 7s1.5-4 4-4a2.5 2.5 0 0 1 0 4"/>',
  crown:  '<path d="M6 4h12v3a6 6 0 0 1-12 0V4Z"/><path d="M6 5H4v1.5A2.5 2.5 0 0 0 6.5 9M18 5h2v1.5A2.5 2.5 0 0 1 17.5 9"/><path d="M10 14h4l-.5 4h-3l-.5-4Z"/><path d="M8.5 20h7"/>',
  heart:  '<path d="M12 20s-7-4.4-7-9.3A4.2 4.2 0 0 1 12 7.6 4.2 4.2 0 0 1 19 10.7c0 4.9-7 9.3-7 9.3Z"/>',
  comment:'<path d="M21 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-10a7.5 7.5 0 0 1 7.5-7.5h2A7.5 7.5 0 0 1 21 11.5Z"/>',
  close:  '<path d="m6 6 12 12M18 6 6 18"/>',
  chev:   '<path d="m9 6 6 6-6 6"/>',
  back:   '<path d="m15 6-6 6 6 6"/>',
  coin:   '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6v8.8M9.6 10h4a1.8 1.8 0 0 1 0 3.6h-4M14.4 10h-4"/>',
  diamond:'<path d="m12 3 7 6-7 12L5 9Z"/><path d="M5 9h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/>',
  plus:   '<path d="M12 5v14M5 12h14"/>',
  share:  '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.6 6.8-4M8.6 13.4l6.8 4"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8 6 12l4 4"/><path d="M6 12h9"/>',
  edit:   '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m15 7 2 2"/>',
  bell:   '<path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z"/><path d="M10 18a2 2 0 0 0 4 0"/>',
  setting:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  shield: '<path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6l-7-3Z"/>',
  check:  '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  clock:  '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3 2"/>',
  fire:   '<path d="M12 3s5 4.4 5 9a5 5 0 0 1-10 0c0-1.6.6-2.9 1.4-4 .5 1 1.2 1.6 2.1 1.9C10.2 8.6 11 5.8 12 3Z"/>',
  send:   '<path d="m4 12 16-8-6 16-3-6-7-2Z"/>',
  home:   '<path d="m4 11 8-7 8 7"/><path d="M6 10v10h12V10"/>',
  compass:'<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v3"/><path d="M3 7v10a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2Z"/><circle cx="16.5" cy="14" r="1.2" fill="currentColor"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 5H5v1.5A3.5 3.5 0 0 0 8.5 10M16 5h3v1.5A3.5 3.5 0 0 1 15.5 10"/><path d="M12 13v3"/><path d="M8.5 20h7"/><path d="M10 16h4l.5 4h-5l.5-4Z"/>',
  star:   '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1.1 5.8-5.3-2.9-5.3 2.9 1.1-5.8L3.5 9.7l5.9-.8L12 3.5Z"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z"/><path d="M16 9a4.2 4.2 0 0 1 0 6"/><path d="M18.5 6.8a7.6 7.6 0 0 1 0 10.4"/>',
  volumeOff:'<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  ban:    '<circle cx="12" cy="12" r="8.5"/><path d="m6.5 6.5 11 11"/>',
  pin:    '<path d="M12 21s-6.5-5.4-6.5-10.4a6.5 6.5 0 0 1 13 0C18.5 15.6 12 21 12 21Z"/><circle cx="12" cy="10.6" r="2.3"/>',
  globe:  '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14.5 14.5 0 0 1 0 18M12 3a14.5 14.5 0 0 0 0 18"/>',
  moon:   '<path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5Z"/>',
  sun:    '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7"/>',
  info:   '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v6"/>',
  help:   '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.2a2.7 2.7 0 1 1 3.8 3c-.8.6-1.2 1-1.2 2M12 17.4h.01"/>',
  phone:  '<path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2Z"/>',
  mail:   '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  google: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5a4.5 4.5 0 1 0 4.3 5.8H12"/><path d="M16.3 13.3H21a9 9 0 0 1-17.4 1.4" />',
  camera: '<rect x="3" y="7" width="18" height="13" rx="3"/><path d="M8.5 7 10 4.5h4L15.5 7"/><circle cx="12" cy="13.4" r="3.4"/>',
  crownS: '<path d="M4 8l3 3 5-6 5 6 3-3v9H4V8Z" fill="currentColor" stroke="none"/>',
};

// ── formatting ─────────────────────────────────────────────────────────────
export function compact(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

export function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockLabel(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── avatars ────────────────────────────────────────────────────────────────
const AVATAR_GRADIENTS = [
  ['#22c55e', '#0ea5e9'], ['#a3e635', '#22c55e'], ['#7b5cff', '#25d0ff'],
  ['#f43f5e', '#f59e0b'], ['#8b5cf6', '#ec4899'], ['#06b6d4', '#3b82f6'],
  ['#f97316', '#eab308'], ['#14b8a6', '#84cc16'],
];
function gradientFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}
/** Deterministic SVG avatar with the initial letter (no upload needed). */
export function svgAvatar(name, seed) {
  const [a, b] = gradientFor(seed || name || 'x');
  const initials = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
      </linearGradient></defs>
      <rect width="160" height="160" fill="url(#g)"/>
      <text x="80" y="104" font-family="Segoe UI,Roboto,Helvetica,sans-serif" font-size="72"
        font-weight="700" fill="rgba(255,255,255,.92)" text-anchor="middle">${initials}</text>
    </svg>`);
}

// ── room themes (procedural covers: no external images, always on-brand) ──
export const THEMES = {
  bamboo: { a: '#34d399', b: '#0d9488', c: '#04211d', emoji: '🎋', label: 'বাঁশ' },
  gold:   { a: '#ffb020', b: '#ff7a1f', c: '#3a1a00', emoji: '🎉', label: 'গোল্ড' },
  rose:   { a: '#ff4d8d', b: '#c026d3', c: '#3b0764', emoji: '🌹', label: 'রোজ' },
  ocean:  { a: '#22d3ee', b: '#2563eb', c: '#082f49', emoji: '🌊', label: 'ওশান' },
  violet: { a: '#a78bfa', b: '#6d28d9', c: '#1e1b4b', emoji: '🎤', label: 'ভায়োলেট' },
  mint:   { a: '#34d399', b: '#0ea5e9', c: '#032b26', emoji: '🫧', label: 'মিন্ট' },
  sunset: { a: '#fbbf24', b: '#f43f5e', c: '#4c0519', emoji: '🌅', label: 'সানসেট' },
  night:  { a: '#6366f1', b: '#1e293b', c: '#020617', emoji: '🌙', label: 'নাইট' },
};

export const CATEGORY_EMOJI = {
  broadcast: '📻', party: '🎉', sing: '🎤', birthday: '🎂', music: '🎵',
  gaming: '🎮', chat: '☕', study: '📚', dance: '💃', comedy: '😂',
};

export const CATEGORY_LABEL = {
  broadcast: 'সম্প্রচার', party: 'পার্টি', sing: 'গান', birthday: 'জন্মদিন', music: 'মিউজিক',
  gaming: 'গেমিং', chat: 'আড্ডা', study: 'পড়াশোনা', dance: 'নাচ', comedy: 'কমেডি',
};

export const CATEGORIES = [
  { id: 'all', label: 'সব' },
  { id: 'chat', label: 'আড্ডা' },
  { id: 'party', label: 'পার্টি' },
  { id: 'sing', label: 'গান' },
  { id: 'music', label: 'মিউজিক' },
  { id: 'gaming', label: 'গেমিং' },
  { id: 'birthday', label: 'জন্মদিন' },
  { id: 'dance', label: 'নাচ' },
  { id: 'comedy', label: 'কমেডি' },
  { id: 'study', label: 'পড়াশোনা' },
  { id: 'broadcast', label: 'সম্প্রচার' },
];

/** Deterministic SVG room cover from the theme palette. */
export function roomCover(theme = 'bamboo', emoji = '🎙️') {
  const th = THEMES[theme] || THEMES.bamboo;
  const W = 240, H = 300;
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="v" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${th.b}"/><stop offset="1" stop-color="${th.c}"/>
    </linearGradient>
    <radialGradient id="g" cx="0.3" cy="0.2" r="0.9">
      <stop offset="0" stop-color="${th.a}" stop-opacity="0.55"/><stop offset="1" stop-color="${th.a}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#v)"/>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <circle cx="30" cy="40" r="90" fill="${th.a}" opacity="0.14"/>
  <circle cx="210" cy="250" r="110" fill="${th.a}" opacity="0.10"/>
  <text x="${W / 2}" y="${H / 2 + 52}" font-size="130" text-anchor="middle" opacity="0.95"
    style="filter:drop-shadow(0 6px 12px rgba(0,0,0,.28))">${emoji}</text>
</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
}

export const categoryLabel = (c) => CATEGORY_LABEL[c] || (c ? c[0].toUpperCase() + c.slice(1) : 'Room');
export const categoryEmoji = (c) => CATEGORY_EMOJI[c] || '🎙️';

// ── tiny event bus ─────────────────────────────────────────────────────────
export function bus() {
  const map = new Map();
  return {
    on(evt, fn) { (map.get(evt) || map.set(evt, []).get(evt)).push(fn); return () => this.off(evt, fn); },
    off(evt, fn) { const a = map.get(evt); if (a) map.set(evt, a.filter((f) => f !== fn)); },
    emit(evt, ...args) { (map.get(evt) || []).forEach((f) => { try { f(...args); } catch (e) { console.error(e); } }); },
  };
}

// ── ui bits ────────────────────────────────────────────────────────────────
export function toast(msg, kind = '') {
  const layer = document.getElementById('toasts');
  if (!layer) return;
  const t = el('div', { class: 'toast' + (kind ? ' is-' + kind : ''), text: msg });
  layer.append(t);
  setTimeout(() => {
    t.style.transition = 'opacity .22s, transform .22s';
    t.style.opacity = '0';
    t.style.transform = 'translateY(-10px)';
    setTimeout(() => t.remove(), 240);
  }, kind === 'err' ? 3600 : 2400);
}

export function haptic(ms = 12) {
  try { navigator.vibrate?.(ms); } catch (_) {}
}

/** Modal confirm() promise that matches the app design. */
export function confirmBox({ title, body = '', okLabel, danger = false }) {
  return new Promise((resolve) => {
    const modal = el('div', { class: 'modal' },
      el('div', { class: 'modal-scrim', onclick: () => { modal.remove(); resolve(false); } }),
      el('div', { class: 'modal-panel' },
        el('h3', { class: 'modal-title', text: title }),
        body ? el('p', { class: 'modal-body', text: body }) : null,
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn btn--ghost', text: 'বাতিল', onclick: () => { modal.remove(); resolve(false); } }),
          el('button', { class: 'btn ' + (danger ? 'btn--danger' : 'btn--primary'), text: okLabel || 'ঠিক আছে', onclick: () => { modal.remove(); resolve(true); } }),
        )));
    document.body.append(modal);
    requestAnimationFrame(() => modal.classList.add('is-open'));
  });
}

/** Avatar <img> with graceful fallback to a letter tile. */
export function avatarImg(src, name = '?', cls = '') {
  const img = el('img', { class: 'avatar ' + cls, alt: name, loading: 'lazy' });
  img.onerror = () => {
    img.replaceWith(el('span', { class: 'avatar avatar--fallback ' + cls, text: (name || '?').trim().slice(0, 1).toUpperCase() }));
  };
  img.src = src || 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#1c2a24"/><text x="48" y="60" font-size="40" text-anchor="middle" fill="#5eead4">${(name || '?').slice(0, 1).toUpperCase()}</text></svg>`);
  return img;
}
