/* Profile — my account, wallet, settings; also renders any other user's profile. */

import { $, el, toast, svg, ICON, compact, shortId, ago, haptic } from '../util.js';
import { api, session } from '../api.js';

export function mountProfile(App) {
  const root = $('#profileRoot');
  let viewing = null;   // null = me, otherwise a user id

  function renderMe() {
    const u = App.user;
    if (!u) return;
    root.innerHTML = '';
    root.append(hero(u, true), walletCards(), myMomentsSection(), settingsMenu());
  }

  function hero(u, isMe) {
    const wrap = el('div', { class: 'profile-hero' });

    const avatarWrap = el('div', { class: 'profile-avatar-wrap' },
      el('img', { class: 'avatar avatar--lg', src: u.avatar, alt: '' }),
    );
    if (isMe) {
      avatarWrap.append(el('div', {
        class: 'profile-edit-dot', html: svg(ICON.edit, { width: 13, height: 13 }),
        onclick: pickAvatar,
      }));
    }

    wrap.append(el('div', { class: 'profile-row' },
      avatarWrap,
      el('div', { class: 'profile-id' },
        el('div', { class: 'profile-name' },
          el('span', { text: u.displayName }),
          u.vip ? el('span', { class: 'vip-badge', text: 'VIP' }) : null,
          el('span', { class: 'lvl-badge', text: 'Lv.' + u.level }),
        ),
        el('div', { class: 'profile-uid', text: `ID ${shortId(u.id)} · @${u.username}` }),
      ),
    ));

    wrap.append(el('p', { class: 'profile-bio', text: u.bio || (isMe ? 'Tap the pencil to add a bio' : '') }));

    wrap.append(el('div', { class: 'profile-stats' },
      stat(u.following ?? 0, 'Following'),
      stat(u.followers ?? 0, 'Followers'),
      stat(u.friends ?? 0, 'Friends'),
      stat(u.moments ?? 0, 'Moments'),
    ));

    const actions = el('div', { class: 'profile-actions' });
    if (isMe) {
      actions.append(
        el('button', { class: 'btn btn--primary', text: 'Edit profile', onclick: editProfile }),
        el('button', { class: 'btn btn--ghost', text: 'Claim daily bonus', onclick: claimBonus }),
      );
    } else {
      actions.append(
        el('button', {
          class: 'btn ' + (u.isFollowing ? 'btn--ghost' : 'btn--primary'),
          text: u.isFollowing ? 'Following' : '+ Follow',
          onclick: async (ev) => {
            try {
              const res = await api.follow(u.id);
              ev.currentTarget.textContent = res.following ? 'Following' : '+ Follow';
              ev.currentTarget.className = 'btn ' + (res.following ? 'btn--ghost' : 'btn--primary');
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
        el('button', { class: 'btn btn--ghost', text: 'Message', onclick: () => App.events.emit('dm:open', u.id) }),
      );
    }
    wrap.append(actions);
    return wrap;
  }

  const stat = (value, label) => el('div', { class: 'profile-stat' },
    el('b', { text: compact(value) }), el('span', { text: label }));

  function walletCards() {
    return el('div', { class: 'wallet' },
      el('div', { class: 'wallet-card' },
        el('div', { class: 'wallet-ic coins', text: '🪙' }),
        el('div', {},
          el('div', { class: 'wallet-val', id: 'walletCoins', text: compact(App.wallet.coins) }),
          el('div', { class: 'wallet-lbl', text: 'Coins' }),
        ),
      ),
      el('div', { class: 'wallet-card' },
        el('div', { class: 'wallet-ic diamonds', text: '💎' }),
        el('div', {},
          el('div', { class: 'wallet-val', id: 'walletDiamonds', text: compact(App.wallet.diamonds) }),
          el('div', { class: 'wallet-lbl', text: 'Diamonds' }),
        ),
      ),
    );
  }

  function myMomentsSection() {
    const wrap = el('div');
    const head = el('div', { class: 'section-title', text: 'My moments' });
    const body = el('div', { class: 'menu' });
    wrap.append(head, body);

    api.moments().then(({ moments }) => {
      const mine = moments.filter((m) => m.user.id === App.user?.id).slice(0, 5);
      body.innerHTML = '';
      if (!mine.length) {
        body.append(el('div', { style: { padding: '6px 10px 16px', color: 'var(--ink-3)', fontSize: '13px' } },
          'No moments yet — share something from the Moments tab.'));
        return;
      }
      mine.forEach((m) => body.append(el('div', { class: 'moment', style: { margin: '0 2px 8px' } },
        el('p', { class: 'moment-body', style: { margin: '0' }, text: m.body || '(photo)' }),
        el('div', { class: 'moment-actions' },
          el('span', { class: 'moment-act', html: svg(ICON.heart, { width: 15, height: 15 }) + m.likes }),
          el('span', { class: 'moment-act', html: svg(ICON.comment, { width: 15, height: 15 }) + m.comments }),
          el('span', { class: 'moment-act', style: { marginLeft: 'auto' }, text: ago(m.createdAt) }),
        ),
      )));
    }).catch(() => {});

    return wrap;
  }

  function settingsMenu() {
    const menu = el('div', { class: 'menu' });
    const row = (icon, label, hint, onClick, danger) => {
      const r = el('button', { class: 'menu-row' },
        el('span', { class: 'menu-ic', html: svg(icon, { width: 17, height: 17 }) }),
        el('span', { class: 'menu-row-main' },
          el('span', { class: 'menu-label', style: danger ? { color: 'var(--red)' } : {}, text: label }),
          hint ? el('span', { class: 'sheet-row-hint', text: hint }) : null,
        ),
        el('span', { class: 'menu-chev', html: svg(ICON.chev, { width: 16, height: 16 }) }),
      );
      r.addEventListener('click', () => { haptic(); onClick(); });
      return r;
    };

    menu.append(
      el('div', { class: 'section-title', text: 'Account' }),
      row(ICON.fire, 'Server status', 'Live rooms, uptime, version', showServerStatus),
      row(ICON.bell, 'Notifications', 'Gifts, follows and comments', showNotifications),
      row(ICON.shield, 'Privacy & safety', 'Blocking, reporting, mic permissions', showPrivacy),
      row(ICON.setting, 'Settings', 'Audio, theme, storage', showSettings),
      el('div', { class: 'sheet-sep' }),
      row(ICON.logout, 'Sign out', session.token ? 'Ends this session on this device' : '', () => {
        if (!confirm('Sign out of MK Malik?')) return;
        session.clear();
        location.reload();
      }, true),
    );
    return menu;
  }

  // ── actions ──────────────────────────────────────────────────────────────
  function pickAvatar() {
    const input = el('input', { type: 'file', accept: 'image/*', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) return toast('Image must be under 8 MB', 'err');
      toast('Uploading…');
      try {
        const { user } = await api.uploadAvatar(file);
        App.user = { ...App.user, ...user };
        renderMe();
        App.events.emit('user', App.user);
        toast('Avatar updated', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 1000);
  }

  function editProfile() {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '';

    const nameInput = input('Display name', App.user.displayName, 24);
    const bioInput = input('Bio', App.user.bio || '', 200);

    const save = el('button', { class: 'btn btn--primary btn--block', style: { margin: '6px 20px 0', width: 'calc(100% - 40px)' } }, 'Save changes');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const { user } = await api.updateMe({ displayName: nameInput.value.trim(), bio: bioInput.value.trim() });
        App.user = { ...App.user, ...user };
        App.events.emit('user', App.user);
        sheet.hidden = true;
        renderMe();
        toast('Profile saved', 'ok');
      } catch (e) {
        toast(e.message, 'err');
        save.disabled = false;
      }
    });

    panel.append(
      el('div', { class: 'sheet-grip' }),
      el('div', { class: 'sheet-title', text: 'Edit profile' }),
      el('div', { style: { padding: '0 20px' } }, nameInput, bioInput),
      save,
    );
    sheet.hidden = false;
  }

  function input(label, value, maxLength) {
    const field = el('div', { class: 'field' });
    field.append(el('label', { text: label }));
    field.append(el('input', { type: 'text', value, maxlength: maxLength }));
    return field;
  }

  async function claimBonus() {
    try {
      const res = await api.dailyBonus();
      App.setWallet({ coins: res.coins });
      updateWallet();
      toast(`+${res.awarded} coins claimed 🪙`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function showServerStatus() {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '<div class="sheet-grip"></div><div class="sheet-title">Server status</div>'
      + '<div style="padding:0 20px 20px;color:var(--ink-3)">Checking…</div>';
    sheet.hidden = false;
    try {
      const h = await api.health();
      panel.innerHTML = '';
      panel.append(el('div', { class: 'sheet-grip' }), el('div', { class: 'sheet-title', text: 'Server status' }));
      const list = el('div', { class: 'sheet-list' });
      const line = (k, v) => list.append(el('div', { class: 'sheet-row' },
        el('span', { class: 'sheet-row-main' },
          el('span', { class: 'sheet-row-label', text: k }),
        ),
        el('span', { style: { fontSize: '13px', fontWeight: '700', color: 'var(--ink-3)' }, text: String(v) }),
      ));
      line('Health', h.ok ? '✅ Online' : '❌ Degraded');
      line('Live rooms', h.live.rooms);
      line('People talking', h.live.users);
      line('On mic right now', h.live.speakers);
      line('Uptime', Math.floor(h.uptimeSec / 60) + ' min');
      line('Memory', h.memoryMb + ' MB');
      line('Node', h.node);
      line('Version', h.version);
      line('Environment', h.env);
      panel.append(list);
    } catch (e) {
      panel.innerHTML = `<div class="sheet-grip"></div><div class="sheet-title">Server status</div><div style="padding:0 20px 20px;color:var(--red)">${e.message}</div>`;
    }
  }

  async function showNotifications() {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '<div class="sheet-grip"></div><div class="sheet-title">Notifications</div>'
      + '<div style="padding:0 20px 20px;color:var(--ink-3)">Loading…</div>';
    sheet.hidden = false;
    try {
      const { notifications } = await api.notifications();
      panel.innerHTML = '';
      panel.append(el('div', { class: 'sheet-grip' }), el('div', { class: 'sheet-title', text: 'Notifications' }));
      const list = el('div', { class: 'sheet-list' });
      if (!notifications.length) {
        list.append(el('div', { style: { padding: '8px 12px 20px', color: 'var(--ink-3)', fontSize: '13px' } }, 'Nothing yet'));
      }
      notifications.forEach((n) => list.append(el('div', { class: 'sheet-row' },
        el('span', { class: 'menu-ic', text: n.kind === 'gift' ? '🎁' : n.kind === 'follow' ? '👥' : n.kind === 'like' ? '❤️' : '💬' }),
        el('span', { class: 'sheet-row-main' },
          el('span', { class: 'sheet-row-label', text: n.title }),
          el('span', { class: 'sheet-row-hint', text: n.body }),
        ),
        el('span', { style: { fontSize: '11px', color: 'var(--ink-4)' }, text: ago(n.createdAt) }),
      )));
      panel.append(list);
      api.readNotifications().catch(() => {});
    } catch (e) {
      panel.innerHTML = `<div class="sheet-grip"></div><div class="sheet-title">Notifications</div><div style="padding:0 20px 20px;color:var(--red)">${e.message}</div>`;
    }
  }

  function showPrivacy() {
    infoSheet('Privacy & safety', [
      ['🎙️', 'Microphone', 'Only used while you hold a mic seat. It stops the moment you leave the seat.'],
      ['🔒', 'Private rooms', 'Set a PIN when you open a room — only invited people can enter.'],
      ['🛡️', 'Blocking & reporting', 'Long-press any seat to report or remove a person from your mic.'],
      ['📵', 'Camera', 'This app never requests camera access. Audio only.'],
    ]);
  }

  function showSettings() {
    infoSheet('Settings', [
      ['🔊', 'Audio output', 'Tap anywhere after joining a room to unlock playback.'],
      ['🎚️', 'Noise suppression', 'Echo cancellation and auto gain are applied to your mic.'],
      ['🗂️', 'Storage', 'Profile photos and moment images are stored on your own server.'],
      ['🌗', 'Theme', 'Light theme with orange accent — matches the reference design.'],
    ]);
  }

  function infoSheet(title, rows) {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '';
    panel.append(el('div', { class: 'sheet-grip' }), el('div', { class: 'sheet-title', text: title }));
    const list = el('div', { class: 'sheet-list' });
    rows.forEach(([icon, label, hint]) => list.append(el('div', { class: 'sheet-row' },
      el('span', { class: 'menu-ic', text: icon }),
      el('span', { class: 'sheet-row-main' },
        el('span', { class: 'sheet-row-label', text: label }),
        el('span', { class: 'sheet-row-hint', text: hint }),
      ),
    )));
    panel.append(list);
    sheet.hidden = false;
  }

  function updateWallet() {
    const c = $('#walletCoins'); if (c) c.textContent = compact(App.wallet.coins);
    const d = $('#walletDiamonds'); if (d) d.textContent = compact(App.wallet.diamonds);
  }

  // ── other people's profiles ──────────────────────────────────────────────
  async function renderUser(userId) {
    root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--ink-3);font-size:13px">Loading…</div>';
    try {
      const { user } = await api.user(userId);
      const { gifts, total } = await api.userGifts(userId);
      root.innerHTML = '';
      root.append(hero(user, false));

      if (gifts.length) {
        root.append(el('div', { class: 'section-title', text: `Gift wall · ${compact(total)} coins` }));
        const wall = el('div', { class: 'gift-grid' });
        gifts.slice(0, 12).forEach((g) => wall.append(el('div', { class: 'gift-cell' },
          el('span', { class: 'gift-emoji', text: g.emoji }),
          el('span', { class: 'gift-name', text: '×' + g.qty }),
          el('span', { class: 'gift-price', text: compact(g.coins) }),
        )));
        root.append(wall);
      }

      root.append(el('div', { style: { height: '14px' } }),
        el('div', { class: 'menu' }, el('button', {
          class: 'menu-row',
          onclick: () => { goBackToMe(); },
        },
          el('span', { class: 'menu-ic', html: svg(ICON.back, { width: 17, height: 17 }) }),
          el('span', { class: 'menu-label', text: 'Back to my profile' }),
        )));
    } catch (e) {
      root.innerHTML = `<div style="padding:40px;text-align:center;color:var(--red);font-size:13px">${e.message}</div>`;
    }
  }

  function goBackToMe() { viewing = null; renderMe(); }

  // ── wiring ───────────────────────────────────────────────────────────────
  App.events.on('started', renderMe);
  App.events.on('user', () => { if (!viewing) renderMe(); });
  App.events.on('wallet', updateWallet);
  App.events.on('view-profile', (userId) => { viewing = userId; App.events.emit('route:go', 'profile'); renderUser(userId); });

  if (App.user) renderMe();

  return { renderMe, renderUser };
}
