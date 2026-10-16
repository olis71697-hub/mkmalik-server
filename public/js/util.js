/* Shared helpers — DOM, formatting, procedural room covers. */

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

/** Stable short numeric id shown in the UI (like "ID 67"). */
export function shortId(seed) {
  let h = 0;
  for (let i = 0; i < String(seed).length; i++) h = (h * 33 + String(seed).charCodeAt(i)) >>> 0;
  return String(h % 90 + 10);
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── procedural room covers ─────────────────────────────────────────────────
/* Self-contained SVG covers: no external images, instant load, always on-brand. */

const THEMES = {
  gold:   { a: '#ffb020', b: '#ff5a1f', c: '#7a2d00', emoji: '🎉' },
  rose:   { a: '#ff4d8d', b: '#c026d3', c: '#3b0764', emoji: '🎵' },
  ocean:  { a: '#22d3ee', b: '#2563eb', c: '#082f49', emoji: '🌊' },
  violet: { a: '#a78bfa', b: '#6d28d9', c: '#1e1b4b', emoji: '🎤' },
  mint:   { a: '#34d399', b: '#0d9488', c: '#042f2e', emoji: '🫧' },
  sunset: { a: '#fbbf24', b: '#f43f5e', c: '#4c0519', emoji: '🌅' },
  night:  { a: '#6366f1', b: '#1e293b', c: '#020617', emoji: '🌙' },
};

const CATEGORY_EMOJI = {
  broadcast: '📻', party: '🎉', sing: '🎤', birthday: '🎂', music: '🎵',
  gaming: '🎮', chat: '☕', study: '📚', dance: '💃', comedy: '😂',
};

const CATEGORY_LABEL = {
  broadcast: 'Broadcast', party: 'Party', sing: 'Sing', birthday: 'Birthday',
  music: 'Music', gaming: 'Gaming', chat: 'Chat', study: 'Study',
  dance: 'Dance', comedy: 'Comedy',
};

/**
 * Build a cover image as an SVG data-URI.
 * Deterministic per room id, so a room always looks the same.
 */
export function coverFor(room) {
  const t = THEMES[room.theme] || THEMES.gold;
  const seed = room.id || room.title || 'x';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const variant = h % 6;
  const emoji = CATEGORY_EMOJI[room.category] || t.emoji;
  const W = 400, H = 464;

  const patterns = [
    // concentric arcs
    `<g opacity=".16" fill="none" stroke="#fff" stroke-width="2">
       <circle cx="330" cy="90" r="150"/><circle cx="330" cy="90" r="105"/><circle cx="330" cy="90" r="62"/>
     </g>`,
    // diagonal stripes
    `<g opacity=".11" stroke="#fff" stroke-width="16" stroke-linecap="round">
       <path d="M-40 120 L200 -40"/><path d="M20 200 L260 40"/><path d="M80 280 L330 120"/><path d="M140 360 L400 200"/>
     </g>`,
    // dotted grid
    `<g opacity=".2" fill="#fff">
       ${Array.from({ length: 6 }, (_, r) => Array.from({ length: 5 }, (_, c) =>
         `<circle cx="${48 + c * 76}" cy="${70 + r * 74}" r="3.2"/>`).join('')).join('')}
     </g>`,
    // big soft blobs
    `<g opacity=".26">
       <circle cx="70" cy="400" r="140" fill="#fff" opacity=".14"/>
       <circle cx="360" cy="60" r="110" fill="#fff" opacity=".1"/>
     </g>`,
    // sound bars
    `<g opacity=".19" fill="#fff">
       ${Array.from({ length: 11 }, (_, i) => {
         const bh = 40 + ((h >> i) % 7) * 26;
         return `<rect x="${20 + i * 34}" y="${470 - bh}" width="15" height="${bh}" rx="7.5"/>`;
       }).join('')}
     </g>`,
    // wave lines
    `<g opacity=".18" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round">
       <path d="M-20 340 q60 -55 120 0 t120 0 t120 0 t120 0"/>
       <path d="M-20 400 q60 -55 120 0 t120 0 t120 0 t120 0"/>
     </g>`,
  ];

  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="${t.a}"/><stop offset=".55" stop-color="${t.b}"/><stop offset="1" stop-color="${t.c}"/>
    </linearGradient>
    <radialGradient id="v" cx=".5" cy=".28" r=".85">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#000" stop-opacity=".28"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  ${patterns[variant]}
  <rect width="${W}" height="${H}" fill="url(#v)"/>
  <text x="${W / 2 + 4}" y="${H / 2 + 62}" font-size="150" text-anchor="middle"
    opacity=".95" style="filter:drop-shadow(0 6px 12px rgba(0,0,0,.28))">${emoji}</text>
</svg>`;

  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
}

export const categoryLabel = (c) => CATEGORY_LABEL[c] || (c ? c[0].toUpperCase() + c.slice(1) : 'Room');
export const categoryEmoji = (c) => CATEGORY_EMOJI[c] || '🎙️';

export const CATEGORIES = [
  { id: 'all', label: 'Broadcast', emoji: '' },
  { id: 'party', label: 'Party', emoji: '' },
  { id: 'sing', label: 'Sing', emoji: '' },
  { id: 'birthday', label: 'Birthday 2P', emoji: '', vip: true },
  { id: 'music', label: 'Music', emoji: '' },
  { id: 'gaming', label: 'Gaming', emoji: '' },
  { id: 'dance', label: 'Dance', emoji: '' },
  { id: 'comedy', label: 'Comedy', emoji: '' },
  { id: 'study', label: 'Study', emoji: '' },
  { id: 'chat', label: 'Chat', emoji: '' },
];

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
