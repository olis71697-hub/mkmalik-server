/* Home screen — live rooms feed with tabs, pull-to-refresh, people strips. */

import { $, $$, el, toast, svg, ICON, compact, ago, avatarImg, roomCover, categoryEmoji, categoryLabel, CATEGORIES, haptic } from '../util.js';
import { t, isBn } from '../i18n.js';
import { api } from '../api.js';
import { openRoom, openPage } from './room.js';

let mounted = false;

export function mountHome(App) {
  if (mounted) return;
  mounted = true;

  const tabsEl = $('#homeTabs');
  const feed = $('#homeFeed');
  const scroll = $('#homeScroll');
  const onlineEl = $('#homeOnline');
  const ptr = $('#homePtr');

  let sort = 'hot';
  let category = 'all';
  const TABS = [
    ['hot', t('popular')],
    ['new', t('newRooms')],
    ['trending', t('trending')],
    ['followed', t('followed')],
  ];

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const [id, label] of TABS) {
      const b = el('button', { class: id === sort ? 'is-active' : '', text: label, onclick: () => { sort = id; haptic(6); renderTabs(); load(); } });
      tabsEl.append(b);
    }
  }

  function roomCard(room) {
    const faces = el('div', { class: 'card-faces' },
      (room.recentUsers || []).slice(0, 4).map((u) => avatarImg(u.avatar, u.displayName)));
    const card = el('div', { class: 'card', onclick: () => openRoom(App, room.id) },
      el('div', { class: 'card-cover' },
        el('img', { src: room.cover || roomCover(room.theme, categoryEmoji(room.category)), alt: '', loading: 'lazy' }),
        el('div', { class: 'card-live' }, el('i'), `${room.seatsTaken}/${room.seatsTotal}`),
        room.isPrivate ? el('div', { class: 'card-lock', html: svg(ICON.lock) }) : null,
        el('div', { class: 'card-cat', text: categoryEmoji(room.category) + ' ' + categoryLabel(room.category) }),
        faces,
        el('div', { class: 'card-seats' },
          el('span', { text: `${room.online || room.seatsTaken + room.listeners} ${isBn() ? 'জন' : ''} 👥` }),
          el('span', { class: 'free', text: `${room.seatsFree} ${t('freeSeats').replace(/টি সিট খালি| seats free/, isBn() ? 'খালি' : 'free')}` })),
      ),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-title', text: room.title }),
        el('div', { class: 'card-meta' },
          avatarImg(room.host?.avatar, room.host?.displayName),
          el('b', { text: room.host?.displayName || '' }),
          room.seatsFree > 0
            ? el('span', { style: { marginLeft: 'auto', color: 'var(--brand-2)', fontWeight: 800, fontSize: '11px' }, text: `${t('joinRoom')} →` })
            : el('span', { style: { marginLeft: 'auto', color: 'var(--gold)', fontWeight: 700, fontSize: '11px' }, text: '🎧 ' + t('listeners') }))));
    return card;
  }

  function userHCard(u) {
    return el('div', { class: 'hcard', onclick: () => openPage.userProfile(App, u.id) },
      avatarImg(u.avatar, u.displayName, 'avatar--lg'),
      el('div', { class: 'nm', text: u.displayName }),
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
        u.vip ? el('span', { class: 'vip', html: svg(ICON.crownS) + 'VIP' }) : null,
        el('span', { class: 'lvl', text: u.level || 1 })),
    );
  }

  function skeletons(n = 4) {
    feed.innerHTML = '';
    const g = el('div', { class: 'grid' });
    for (let i = 0; i < n; i++) g.append(el('div', { class: 'skeleton' }));
    feed.append(g);
  }

  async function load({ silent } = {}) {
    if (!silent) skeletons();
    try {
      const [roomsR, usersR] = await Promise.all([
        api.rooms({ sort, category: category === 'all' ? undefined : category }),
        api.users(sort === 'new' ? 'new' : 'popular'),
      ]);
      feed.innerHTML = '';
      const rooms = roomsR.rooms || [];
      const stats = roomsR.stats || {};

      onlineEl.innerHTML = '';
      onlineEl.append(el('span', {},
        el('span', { class: 'on-dot', style: { display: 'inline-block', transform: 'translateY(1px)' } }),
        ` ${stats.users || 0}${t('onlineUsers')} · ${stats.rooms || 0}${t('liveRoomsCount')} · ${stats.speakers || 0}${t('speakers')}`));

      if (!rooms.length) {
        feed.append(el('div', { class: 'empty-state' },
          el('div', { class: 'empty-emoji', text: '🐼' }),
          el('h3', { text: t('empty') }),
          el('p', { text: isBn() ? 'প্রথম রুমটি আপনিই খুলুন!' : 'Be the first — open a room!' }),
          el('button', { class: 'btn btn--primary', text: '🎤 ' + t('createRoom'), onclick: () => openPage.createRoom(App) })));
        return;
      }

      feed.append(el('div', { class: 'section-head' },
        el('h2', { text: t('liveRooms') }),
        el('span', { class: 'count', text: String(rooms.length) })));
      const grid = el('div', { class: 'grid' });
      rooms.forEach((r) => grid.append(roomCard(r)));
      feed.append(grid);

      const users = (usersR.users || []).slice(0, 10);
      if (users.length) {
        feed.append(el('div', { class: 'section-head' },
          el('h2', { text: sort === 'new' ? t('newUsers') : t('popularUsers') }),
          el('span', { class: 'link', text: t('viewAll'), onclick: () => { import('../app.js').then(({ go }) => go('discover')); } })));
        const row = el('div', { class: 'hlist' });
        users.forEach((u) => row.append(userHCard(u)));
        feed.append(row);
      }
    } catch (e) {
      if (!silent) {
        feed.innerHTML = '';
        feed.append(el('div', { class: 'empty-state' },
          el('div', { class: 'empty-emoji', text: '📡' }),
          el('h3', { text: t('error') }),
          el('p', { text: e.message }),
          el('button', { class: 'btn btn--ghost', text: t('retry'), onclick: () => load() })));
      }
    }
  }

  // ---- pull to refresh ----
  let ptrBusy = false;
  scroll.addEventListener('touchstart', (e) => {
    if (scroll.scrollTop <= 0 && !ptrBusy) ptr.dataset.y = e.touches[0].clientY;
  }, { passive: true });
  scroll.addEventListener('touchmove', (e) => {
    const y0 = Number(ptr.dataset.y || 0);
    if (!y0 || ptrBusy) return;
    const dy = e.touches[0].clientY - y0;
    if (dy > 72) { ptr.hidden = false; ptr.textContent = '↑ ' + (isBn() ? 'ছেড়ে দিন রিফ্রেশের জন্য' : 'Release to refresh'); }
  }, { passive: true });
  scroll.addEventListener('touchend', (e) => {
    const y0 = Number(ptr.dataset.y || 0);
    ptr.dataset.y = 0;
    if (!y0 || ptrBusy) return;
    const dy = e.changedTouches[0].clientY - y0;
    ptr.hidden = true;
    if (dy > 72) {
      ptrBusy = true;
      haptic(14);
      ptr.hidden = false;
      ptr.textContent = '⟳ ' + t('loading');
      load({ silent: false }).finally(() => { ptr.hidden = true; ptrBusy = false; });
    }
  }, { passive: true });

  renderTabs();
  load();

  App.events.on('route', (name) => { if (name === 'home') load({ silent: true }); });
}
