/* ---------------------------------------------------------------------------
   Explore — the home grid.

   Layout mirrors the reference design:
     [ Related   Hot   Explore ]              🏆  🔍  ⊕
     Broadcast   Party   Sing   Birthday 2P
     ┌──────────┐  ┌──────────┐
     │ 0/10  👥 │  │ 1/8   🔒 │
     │  cover   │  │  cover   │
     │ 🎉 Party │  │ 🎉 Party │
     └──────────┘  └──────────┘
     Share a happy thing😊
     🎤 There are 9 seats left
   --------------------------------------------------------------------------- */

import {
  $, el, toast, svg, ICON, coverFor, compact, categoryLabel, categoryEmoji,
  shortId, CATEGORIES, haptic,
} from '../util.js';
import { api } from '../api.js';

export function mountExplore(App) {
  const grid        = $('#exploreGrid');
  const emptyState  = $('#exploreEmpty');
  const chipsBar    = $('#exploreChips');
  const scroll      = $('#exploreScroll');
  const tabs        = $('#exploreTabs');

  let state = {
    sort: 'hot',          // related | hot | explore
    category: 'all',
    q: '',
    rooms: [],
    loading: false,
    loadedOnce: false,
  };

  // ── chips ────────────────────────────────────────────────────────────────
  function renderChips() {
    chipsBar.innerHTML = '';
    CATEGORIES.forEach((c) => {
      const btn = el('button', {
        class: 'chip' + (state.category === c.id ? ' is-active' : ''),
        'data-cat': c.id,
        onclick: () => {
          state.category = c.id;
          renderChips();
          load();
        },
      }, c.label);
      if (c.vip) btn.append(el('span', { class: 'v-badge', text: 'V' }));
      chipsBar.append(btn);
    });
  }

  // ── card ─────────────────────────────────────────────────────────────────
  function cardEl(room, index) {
    const taken = room.seatsTaken;
    const total = room.seatsTotal;
    const free  = room.seatsFree;

    const seatState = free === 0 ? 'is-full' : free <= 2 ? 'is-warn' : '';

    const media = el('div', { class: 'card-media' });

    const img = el('img', { class: 'card-cover', alt: '', loading: 'lazy', src: coverFor(room) });
    media.append(img);

    // top-left seat counter
    media.append(el('div', { class: `card-seats ${seatState}` },
      el('span', { class: 'bar' }),
      el('span', { text: `${taken}/${total}` }),
    ));

    // top-right avatar stack + live listeners
    const stack = el('div', { class: 'card-top-right' });
    const faces = (room.recentUsers || []).slice(0, 3);
    if (faces.length) {
      const facesWrap = el('div', { class: 'card-stack' });
      faces.forEach((u) => facesWrap.append(el('img', { src: u.avatar, alt: '', loading: 'lazy' })));
      stack.append(facesWrap);
    }
    stack.append(el('span', { class: 'card-listener-count', text: String(room.online || 0) }));
    media.append(stack);

    // bottom-left category tag
    media.append(el('div', { class: 'card-tag' },
      el('span', { text: categoryEmoji(room.category) }),
      el('span', { text: categoryLabel(room.category) }),
    ));

    if (room.isPrivate) {
      media.append(el('div', { class: 'card-lock', html: svg(ICON.lock, { width: 14, height: 14 }) }));
    }

    // subtitle: "There are N seats left"
    const subText = free === 0
      ? 'All 10 mics taken'
      : `There are ${free} seat${free === 1 ? '' : 's'} left`;

    return el('button', {
      class: 'card' + (room.pinned && index === 0 ? ' card--featured' : ''),
      style: { animationDelay: `${Math.min(index, 9) * 26}ms` },
      'data-room': room.id,
      onclick: () => openRoom(room),
    },
      media,
      el('div', { class: 'card-title', text: room.title }),
      el('div', { class: 'card-sub' + (free <= 2 ? ' is-hot' : '') },
        el('span', { html: svg(ICON.mic, { width: 13, height: 13 }) }),
        el('span', { text: subText }),
      ),
    );
  }

  function skeleton() {
    grid.innerHTML = '';
    const wrap = el('div', { class: 'skel', style: { gridColumn: '1 / -1' } });
    for (let i = 0; i < 6; i++) {
      wrap.append(el('div', { class: 'skel-card' },
        el('div', { class: 'skel-cover' }),
        el('div', { class: 'skel-line' }),
        el('div', { class: 'skel-line short' }),
      ));
    }
    grid.append(wrap);
  }

  // ── data ─────────────────────────────────────────────────────────────────
  async function load() {
    if (state.loading) return;
    state.loading = true;
    if (!state.loadedOnce) skeleton();

    try {
      const params = { sort: state.sort };
      if (state.category !== 'all') params.category = state.category;
      if (state.q) params.q = state.q;

      const data = await api.rooms(params);
      state.rooms = data.rooms || [];
      state.loadedOnce = true;
      render();
    } catch (e) {
      grid.innerHTML = '';
      emptyState.hidden = false;
      toast(e.message, 'err');
    } finally {
      state.loading = false;
    }
  }

  function render() {
    grid.innerHTML = '';
    if (!state.rooms.length) {
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;
    const frag = document.createDocumentFragment();
    state.rooms.forEach((r, i) => frag.append(cardEl(r, i)));
    grid.append(frag);
  }

  // ── open a room ──────────────────────────────────────────────────────────
  function openRoom(room) {
    haptic();
    App.events.emit('room:open', { roomId: room.id, room });
  }

  // ── create-room sheet ────────────────────────────────────────────────────
  function openCreateSheet() {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '';

    let category = 'party';
    let isPrivate = false;
    let locked = false;

    const titleInput = el('input', {
      type: 'text', maxlength: 60, placeholder: 'Give your room a name',
      style: {
        width: 'calc(100% - 40px)', height: '46px', margin: '0 20px 12px', padding: '0 15px',
        borderRadius: '14px', border: '1.5px solid var(--line)', background: 'var(--surface-2)',
        fontSize: '15px', outline: '0',
      },
    });

    const topicInput = el('input', {
      type: 'text', maxlength: 120, placeholder: 'What is this room about? (optional)',
      style: {
        width: 'calc(100% - 40px)', height: '46px', margin: '0 20px 14px', padding: '0 15px',
        borderRadius: '14px', border: '1.5px solid var(--line)', background: 'var(--surface-2)',
        fontSize: '15px', outline: '0',
      },
    });

    panel.append(
      el('div', { class: 'sheet-grip' }),
      el('div', { class: 'sheet-title', text: 'Open a live room' }),
      el('div', { class: 'sheet-sub', text: 'You get 10 mic seats. Anyone can listen; you decide who speaks.' }),
      titleInput,
      topicInput,
    );

    // category picker
    const catWrap = el('div', {
      style: { display: 'flex', gap: '8px', overflowX: 'auto', padding: '0 20px 14px', scrollbarWidth: 'none' },
    });
    CATEGORIES.filter((c) => c.id !== 'all').forEach((c) => {
      const b = el('button', {
        class: 'btn btn--sm ' + (category === c.id ? 'btn--primary' : 'btn--ghost'),
        text: c.label,
        onclick: () => {
          category = c.id;
          [...catWrap.children].forEach((n) => {
            const on = n.textContent === c.label;
            n.className = 'btn btn--sm ' + (on ? 'btn--primary' : 'btn--ghost');
          });
        },
      });
      catWrap.append(b);
    });
    panel.append(catWrap);

    // toggles
    const list = el('div', { class: 'sheet-list' });

    const mkToggle = (label, hint, get, set) => {
      const row = el('button', { class: 'sheet-row', type: 'button' },
        el('span', { class: 'menu-ic', html: svg(get() ? ICON.check : ICON.close, { width: 16, height: 16 }) }),
        el('span', { class: 'sheet-row-main' },
          el('span', { class: 'sheet-row-label', text: label }),
          el('span', { class: 'sheet-row-hint', text: hint }),
        ),
      );
      row.addEventListener('click', () => { set(!get()); row.querySelector('.menu-ic').innerHTML = svg(get() ? ICON.check : ICON.close, { width: 16, height: 16 }); });
      return row;
    };

    list.append(
      mkToggle('Private room', 'Only people with the room PIN can join', () => isPrivate, (v) => { isPrivate = v; }),
      mkToggle('Lock the room', 'Nobody new can enter until you unlock', () => locked, (v) => { locked = v; }),
    );
    panel.append(list);

    const go = el('button', { class: 'btn btn--primary btn--block', style: { margin: '14px 20px 0', width: 'calc(100% - 40px)' } }, 'Start room');
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Opening…';
      try {
        const { room, pin } = await api.createRoom({
          title: titleInput.value.trim() || `${App.user?.displayName || 'My'} room 🎙️`,
          topic: topicInput.value.trim(),
          category,
          isPrivate,
          locked,
        });
        sheet.hidden = true;
        await load();
        toast('Room is live — taking your seat…', 'ok');
        App.events.emit('room:open', { roomId: room.id, room, autoSeat: true, pin });
      } catch (e) {
        toast(e.message, 'err');
        go.disabled = false;
        go.textContent = 'Start room';
      }
    });
    panel.append(go);

    sheet.hidden = false;
  }

  // ── leaderboard sheet ────────────────────────────────────────────────────
  async function openRankSheet() {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '';
    panel.append(el('div', { class: 'sheet-grip' }), el('div', { class: 'sheet-title', text: 'Ranking' }));

    let period = 'day';
    const seg = el('div', { style: { display: 'flex', gap: '8px', padding: '0 20px 12px' } });
    const body = el('div', { class: 'sheet-list' });
    panel.append(seg, body);

    async function draw() {
      body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-3)">Loading…</div>';
      try {
        const data = await api.leaderboard(period);
        body.innerHTML = '';
        const section = (title, rows, key, icon) => {
          body.append(el('div', { class: 'section-title', text: title }));
          if (!rows.length) {
            body.append(el('div', { style: { padding: '0 20px 14px', color: 'var(--ink-3)', fontSize: '13px' } }, 'No activity yet'));
            return;
          }
          rows.slice(0, 10).forEach((u, i) => {
            body.append(el('div', { class: 'lb-row' },
              el('span', { class: 'lb-rank' + (i < 3 ? ' top' : ''), text: '#' + (i + 1) }),
              el('img', { class: 'avatar avatar--sm', src: u.avatar, alt: '' }),
              el('span', { class: 'lb-main' },
                el('span', { class: 'lb-name', text: u.display_name }),
                el('span', { class: 'lb-sub', text: `Lv.${u.level}  ·  ${compact(u[key])}` }),
              ),
              el('span', { class: 'lb-value', html: svg(icon, { width: 14, height: 14 }) + compact(u[key]) }),
            ));
          });
        };
        section('Top hosts', data.hosts, 'earned', ICON.diamond);
        section('Top gifters', data.givers, 'spent', ICON.coin);
      } catch (e) {
        body.innerHTML = `<div style="padding:20px;text-align:center;color:var(--ink-3)">${e.message}</div>`;
      }
    }

    [['Today', 'day'], ['This week', 'week']].forEach(([label, val]) => {
      seg.append(el('button', {
        class: 'btn btn--sm ' + (period === val ? 'btn--primary' : 'btn--ghost'),
        text: label,
        onclick: (ev) => {
          period = val;
          [...seg.children].forEach((n) => { n.className = 'btn btn--sm ' + (n.textContent === label ? 'btn--primary' : 'btn--ghost'); });
          draw();
        },
      }));
    });

    sheet.hidden = false;
    draw();
  }

  // ── search sheet ─────────────────────────────────────────────────────────
  function openSearchSheet() {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '';

    const input = el('input', {
      class: 'search-input', type: 'search', placeholder: 'Search rooms, people, tags…', autocomplete: 'off',
    });
    const results = el('div', { class: 'sheet-list', style: { marginTop: '14px' } });

    panel.append(
      el('div', { class: 'sheet-grip' }),
      el('div', { class: 'search-wrap' }, input),
      results,
    );

    let timer = null;
    let seq = 0;

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      timer = setTimeout(async () => {
        if (!q) { results.innerHTML = ''; return; }
        const mine = ++seq;
        results.innerHTML = '<div style="padding:16px;text-align:center;color:var(--ink-3);font-size:13px">Searching…</div>';
        try {
          const data = await api.search(q);
          if (mine !== seq) return;
          results.innerHTML = '';
          if (!data.rooms.length && !data.users.length) {
            results.innerHTML = '<div style="padding:16px;text-align:center;color:var(--ink-3);font-size:13px">Nothing found</div>';
            return;
          }
          if (data.rooms.length) {
            results.append(el('div', { class: 'section-title', text: 'Live rooms' }));
            data.rooms.forEach((r) => results.append(el('button', {
              class: 'sheet-row',
              onclick: () => { sheet.hidden = true; openRoom(r); },
            },
              el('img', { class: 'avatar avatar--sm', src: coverFor(r), alt: '', style: { borderRadius: '10px' } }),
              el('span', { class: 'sheet-row-main' },
                el('span', { class: 'sheet-row-label', text: r.title }),
                el('span', { class: 'sheet-row-hint', text: `${categoryLabel(r.category)} · ${r.seatsFree} seats free` }),
              ),
              el('span', { class: 'menu-chev', html: svg(ICON.chev, { width: 16, height: 16 }) }),
            )));
          }
          if (data.users.length) {
            results.append(el('div', { class: 'section-title', text: 'People' }));
            data.users.forEach((u) => results.append(el('button', {
              class: 'sheet-row',
              onclick: () => { sheet.hidden = true; App.events.emit('view-profile', u.id); },
            },
              el('img', { class: 'avatar avatar--sm', src: u.avatar, alt: '' }),
              el('span', { class: 'sheet-row-main' },
                el('span', { class: 'sheet-row-label', text: u.displayName }),
                el('span', { class: 'sheet-row-hint', text: `@${u.username} · Lv.${u.level}` }),
              ),
              el('span', { class: 'menu-chev', html: svg(ICON.chev, { width: 16, height: 16 }) }),
            )));
          }
        } catch (e) {
          results.innerHTML = `<div style="padding:16px;text-align:center;color:var(--ink-3);font-size:13px">${e.message}</div>`;
        }
      }, 260);
    });

    sheet.hidden = false;
    setTimeout(() => input.focus(), 220);
  }

  // ── tabs ─────────────────────────────────────────────────────────────────
  tabs?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (!btn) return;
    state.sort = btn.dataset.sort;
    tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === btn));
    // "Explore" is the widest net — clear any category filter
    if (state.sort === 'explore') { state.category = 'all'; renderChips(); }
    load();
  });

  $('#btnRank')?.addEventListener('click', openRankSheet);
  $('#btnSearch')?.addEventListener('click', openSearchSheet);
  $('#btnDiscover')?.addEventListener('click', () => {
    state.sort = 'explore';
    state.category = 'all';
    state.q = '';
    tabs?.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.sort === 'explore'));
    renderChips();
    load();
    toast('Showing every live room');
  });

  App.events.on('create-room', openCreateSheet);
  App.events.on('rooms:refresh', load);

  // ── scroll polish: stick the chips bar ───────────────────────────────────
  scroll?.addEventListener('scroll', () => {
    chipsBar.classList.toggle('is-stuck', scroll.scrollTop > 4);
  }, { passive: true });

  renderChips();
  load();

  // periodic refresh so the grid stays live
  setInterval(() => {
    if (App.current === 'explore' && document.visibilityState === 'visible') load();
  }, 25_000);

  return { load, openCreateSheet };
}
