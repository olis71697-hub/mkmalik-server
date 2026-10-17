/* Discover — search rooms/users/IDs, category + language filters, people tabs. */

import { $, $$, el, toast, svg, ICON, compact, avatarImg, roomCover, categoryEmoji, categoryLabel, CATEGORIES, haptic } from '../util.js';
import { t, isBn } from '../i18n.js';
import { api } from '../api.js';
import { openRoom, openPage } from './room.js';

let mounted = false;
let recent = [];
try { recent = JSON.parse(localStorage.getItem('panda.recentSearch') || '[]'); } catch (_) {}
const saveRecent = () => { try { localStorage.setItem('panda.recentSearch', JSON.stringify(recent.slice(0, 8))); } catch (_) {} };

export function mountDiscover(App) {
  if (mounted) return;
  mounted = true;

  const input = $('#discoverInput');
  const chips = $('#discoverChips');
  const feed = $('#discoverFeed');
  const recentEl = $('#discoverRecent');

  let filter = 'all';       // 'all' | category id | 'lang:bn' | 'lang:en'
  let searchTimer = null;

  const FILTERS = [
    { id: 'all', label: t('popular') },
    ...CATEGORIES.filter((c) => c.id !== 'all').map((c) => ({ id: c.id, label: c.label, emoji: categoryEmoji(c.id) })),
    { id: 'lang:bn', label: '🇧🇩 বাংলা' },
    { id: 'lang:en', label: '🌐 EN' },
  ];

  function renderChips() {
    chips.innerHTML = '';
    for (const f of FILTERS) {
      chips.append(el('button', {
        class: 'chip' + (filter === f.id ? ' is-active' : ''),
        text: (f.emoji ? f.emoji + ' ' : '') + f.label,
        onclick: () => { filter = f.id; haptic(6); renderChips(); input.value ? search(input.value.trim()) : loadBrowse(); },
      }));
    }
  }

  function renderRecent() {
    recentEl.innerHTML = '';
    if (recent.length && !input.value) {
      recentEl.append(el('div', { class: 'section-head' }, el('h2', { text: '🕘 ' + (isBn() ? 'সাম্প্রতিক সার্চ' : 'Recent') })));
      const row = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' } });
      recent.forEach((q) => {
        row.append(el('button', { class: 'recent-tag', text: '⏱ ' + q, onclick: () => { input.value = q; search(q); } }));
      });
      recentEl.append(row);
    }
  }

  function userRow(u) {
    return el('div', { class: 'user-row', onclick: () => openPage.userProfile(App, u.id) },
      avatarImg(u.avatar, u.displayName, 'avatar--sm'),
      el('div', { class: 'meta' },
        el('div', { class: 'name' },
          el('span', { text: u.displayName }),
          u.vip ? el('span', { class: 'vip', html: svg(ICON.crownS) + 'VIP' }) : null,
          el('span', { class: 'lvl', text: u.level || 1 })),
        el('div', { class: 'sub' },
          el('span', { class: 'on-dot' + (u.online ? '' : ' is-off') }),
          el('span', { text: `ID ${u.userCode || '—'} · ${compact(u.followers || 0)} ${t('followers')}` }))),
      el('button', {
        class: 'btn btn--sm ' + (u.isFollowing ? 'btn--ghost' : 'btn--primary'),
        text: u.isFollowing ? t('unfollow') : t('follow'),
        onclick: async (e) => {
          e.stopPropagation();
          try { const r = await api.follow(u.id); u.isFollowing = r.following; e.target.textContent = r.following ? t('unfollow') : t('follow'); e.target.className = 'btn btn--sm ' + (r.following ? 'btn--ghost' : 'btn--primary'); }
          catch (err) { toast(err.message, 'err'); }
        },
      }));
  }

  function roomRow(r) {
    return el('div', { class: 'user-row', onclick: () => openRoom(App, r.id) },
      el('img', { src: r.cover || roomCover(r.theme, categoryEmoji(r.category)), style: { width: '52px', height: '52px', borderRadius: '14px', objectFit: 'cover' }, alt: '' }),
      el('div', { class: 'meta' },
        el('div', { class: 'name' }, el('span', { text: r.title })),
        el('div', { class: 'sub' }, el('span', { text: `🎙 ${r.seatsTaken}/${r.seatsTotal} · 👥 ${r.online || r.seatsTaken + r.listeners} · ${categoryEmoji(r.category)} ${categoryLabel(r.category)}` }))),
      el('span', { class: 'btn btn--sm btn--primary', text: t('joinRoom') }));
  }

  async function search(q) {
    if (!q) { loadBrowse(); return; }
    feed.innerHTML = '';
    feed.append(el('div', { class: 'spin' }));
    try {
      const r = await api.search(q);
      if (!recent.includes(q)) { recent.unshift(q); recent = recent.slice(0, 8); saveRecent(); }
      feed.innerHTML = '';
      if (r.users?.length) {
        feed.append(el('div', { class: 'section-head' }, el('h2', { text: '👤 ' + (isBn() ? 'ইউজার' : 'Users') }), el('span', { class: 'count', text: String(r.users.length) })));
        r.users.forEach((u) => feed.append(userRow(u)));
      }
      if (r.rooms?.length) {
        feed.append(el('div', { class: 'section-head' }, el('h2', { text: '🎙 ' + (isBn() ? 'রুম' : 'Rooms') }), el('span', { class: 'count', text: String(r.rooms.length) })));
        r.rooms.forEach((rm) => feed.append(roomRow(rm)));
      }
      if (!r.users?.length && !r.rooms?.length) {
        feed.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '🔍' }), el('h3', { text: t('empty') }), el('p', { text: isBn() ? `“${q}” এর জন্য কিছু পাওয়া যায়নি` : `Nothing found for “${q}”` })));
      }
    } catch (e) {
      feed.innerHTML = '';
      feed.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '📡' }), el('h3', { text: t('error') }), el('p', { text: e.message })));
    }
  }

  async function loadBrowse() {
    feed.innerHTML = '';
    feed.append(el('div', { class: 'spin' }));
    try {
      const params = {};
      if (filter.startsWith('lang:')) { params.language = filter.slice(5); params.sort = 'hot'; }
      else if (filter !== 'all') { params.category = filter; params.sort = 'hot'; }
      else params.sort = 'trending';

      const [roomsR, usersR] = await Promise.all([api.rooms(params), api.users(filter === 'all' ? 'live' : 'popular')]);
      feed.innerHTML = '';

      const rooms = roomsR.rooms || [];
      if (rooms.length) {
        feed.append(el('div', { class: 'section-head' }, el('h2', { text: '🔥 ' + t('trending') })));
        rooms.slice(0, 8).forEach((rm) => feed.append(roomRow(rm)));
      }
      const users = usersR.users || [];
      if (users.length) {
        feed.append(el('div', { class: 'section-head' }, el('h2', { text: '⭐ ' + (filter === 'all' ? (isBn() ? 'লাইভ ইউজার' : 'Live users') : t('popularUsers')) })));
        users.slice(0, 20).forEach((u) => feed.append(userRow(u)));
      }
    } catch (e) {
      feed.innerHTML = '';
      feed.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '📡' }), el('h3', { text: t('error') }), el('p', { text: e.message })));
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    searchTimer = setTimeout(() => { q ? search(q) : loadBrowse(); }, 320);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); search(input.value.trim()); } });

  renderChips();
  renderRecent();
  loadBrowse();

  App.events.on('route', (name) => { if (name === 'discover') { renderRecent(); if (!input.value) loadBrowse(); } });
}
