/* Own profile screen (other users open through openPage.userProfile). */

import { $, $$, el, toast, svg, ICON, compact, avatarImg, haptic } from '../util.js';
import { t, isBn } from '../i18n.js';
import { api } from '../api.js';
import { openPage } from './extra.js';

let mounted = false;

export function mountProfile(App) {
  if (mounted) return;
  mounted = true;

  const scroll = $('#profileScroll');

  async function load() {
    if (!App.user) return;
    let me = App.user;
    try { me = (await api.me()).user; App.setUser(me); } catch (_) {}
    const u = me;

    scroll.innerHTML = '';

    scroll.append(el('div', { class: 'profile-hero' },
      el('div', { class: 'profile-ava' },
        avatarImg(u.avatar, u.displayName, 'avatar--xl'),
        el('span', { class: 'lvl-float', text: `Lv ${u.level || 1} ${u.vip ? '· VIP' : ''}` })),
      el('div', { class: 'profile-name' },
        el('span', { text: u.displayName }),
        u.vip ? el('span', { class: 'vip', html: svg(ICON.crownS) + 'VIP' }) : null),
      el('div', { class: 'profile-id', text: `@${u.username} · ${t('userId')} ${u.userCode || '—'}` }),
      u.bio ? el('p', { class: 'profile-bio', text: u.bio }) : null,
      el('div', { class: 'profile-xp' },
        el('div', { class: 'bar' }, el('i', { style: { width: pct(u) + '%' } })),
        el('div', { class: 'lbl' }, el('span', { text: `XP ${compact(u.xp || 0)}` }), el('span', { text: `Lv ${u.level || 1} → ${(u.level || 1) + 1}` })))));

    scroll.append(el('div', { class: 'stat-row', style: { background: 'var(--bg)' } },
      stat(compact(u.followers || 0), t('followers'), () => openPage.followList(App, u.id, 'followers', t('followers'))),
      stat(compact(u.following || 0), t('following'), () => openPage.followList(App, u.id, 'following', t('following'))),
      stat(compact(u.giftsReceivedCoins || 0), t('giftsReceived')),
      stat(compact(u.giftsSentCoins || 0), t('giftsSent'))));

    scroll.append(el('div', { class: 'profile-actions' },
      el('button', { class: 'btn btn--primary', html: svg(ICON.edit) + ' ' + t('editProfile'), onclick: () => openPage.editProfile(App) }),
      el('button', { class: 'btn btn--ghost', html: svg(ICON.trophy) + ' ' + t('leaderboard'), onclick: () => openPage.leaderboard(App) }),
      el('button', { class: 'btn btn--ghost', html: svg(ICON.setting) + ' ' + t('settings'), onclick: () => openPage.settings(App) })));

    // wallet shortcut
    const u2 = await api.me().catch(() => null);
    if (u2?.wallet) {
      scroll.append(el('div', { class: 'list-card', style: { margin: '6px 14px' } },
        el('button', { class: 'list-row', onclick: () => import('../app.js').then(({ go }) => go('wallet')) },
          el('span', { class: 'li-icon is-gold', html: svg(ICON.coin) }),
          el('span', { class: 'li-body' }, el('span', { class: 'li-t', text: t('wallet') }), el('span', { class: 'li-s', text: `${compact(u2.wallet.coins)} ${t('coins')} · 💎 ${compact(u2.wallet.diamonds)}` })),
          el('span', { class: 'li-end', html: svg(ICON.chev) }))));
    }

    // info rows
    const infoCard = el('div', { class: 'list-card', style: { margin: '12px 14px' } });
    infoCard.append(
      row(ICON.user, `@${u.username}`, `${t('userId')} ${u.userCode || '—'}`),
      row(ICON.globe, u.country || (isBn() ? 'দেশ নির্বাচন করুন' : 'Set country'), ''),
      row(ICON.clock, t('memberSince'), new Date(u.createdAt).toLocaleDateString(isBn() ? 'bn-BD' : 'en-GB')),
      row(ICON.mic, t('roomsHosted'), String(u.roomsHosted || 0)));
    scroll.append(infoCard);

    // danger zone
    scroll.append(el('div', { class: 'list-card', style: { margin: '12px 14px' } },
      el('button', { class: 'list-row is-danger', onclick: () => openPage.deleteAccount(App) },
        el('span', { class: 'li-icon is-danger', html: svg(ICON.close) }),
        el('span', { class: 'li-body' }, el('span', { class: 'li-t', text: t('deleteAccount') })))));

    scroll.append(el('div', { class: 'center-note', text: 'Panda Voice v1.0.0 🐼 · ' + t('version') + ' 1.0.0' }));
  }

  function stat(value, label, onclick) {
    const s = el('div', { class: 'stat' }, el('b', { text: value }), el('span', { text: label }));
    if (onclick) s.style.cursor = 'pointer', s.onclick = onclick;
    return s;
  }
  function row(icon, title, sub) {
    return el('div', { class: 'list-row' },
      el('span', { class: 'li-icon', html: svg(icon) }),
      el('span', { class: 'li-body' }, el('span', { class: 'li-t', text: title }), sub ? el('span', { class: 'li-s', text: sub }) : null));
  }

  const pct = (u) => Math.max(4, Math.min(100, Math.round(((u.xp || 0) - (u.xpFloor || 0)) / Math.max(1, (u.xpNext || 100) - (u.xpFloor || 0)) * 100)));

  App.events.on('route', (name) => { if (name === 'profile') load(); });
  App.events.on('user', () => { if (App.current === 'profile') load(); });
  load();
}
