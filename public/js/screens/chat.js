/* Messages screen — conversation list. */

import { $, $$, el, toast, svg, ICON, avatarImg, haptic } from '../util.js';
import { t, isBn } from '../i18n.js';
import { api } from '../api.js';
import { openPage } from './extra.js';

let mounted = false;

export function mountChat(App) {
  if (mounted) return;
  mounted = true;

  const list = $('#convList');
  const scroll = $('#msgScroll');

  async function load() {
    try {
      const r = await api.conversations();
      list.innerHTML = '';
      const convs = r.conversations || [];
      App.unread.messages = convs.reduce((s, c) => s + (c.unread || 0), 0);
      import('../app.js').then(({ refreshBadges }) => refreshBadges());

      if (!convs.length) {
        list.append(el('div', { class: 'empty-state' },
          el('div', { class: 'empty-emoji', text: '💬' }),
          el('h3', { text: t('noConversations') }),
          el('button', { class: 'btn btn--primary', text: '👤 ' + (isBn() ? 'ইউজার খুঁজুন' : 'Find people'), onclick: () => import('../app.js').then(({ go }) => go('discover')) })));
        return;
      }

      convs.forEach((c) => {
        if (!c.other) return;
        list.append(el('div', { class: 'conv-row', onclick: () => openPage.chatThread(App, c.other.id, c.other) },
          avatarImg(c.other.avatar, c.other.displayName),
          el('div', { class: 'meta' },
            el('div', { class: 'r1' },
              el('span', { class: 'nm', text: c.other.displayName }),
              el('span', { class: 'tm', text: timeShort(c.lastAt) })),
            el('div', { class: 'r2' },
              el('span', { class: 'pv', text: c.lastBody || '…' }),
              c.unread ? el('span', { class: 'act-badge', text: String(c.unread) }) : null))));
      });
    } catch (e) {
      list.innerHTML = '';
      list.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '📡' }), el('p', { text: e.message })));
    }
  }

  function timeShort(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString(isBn() ? 'bn-BD' : 'en-GB', { month: 'short', day: 'numeric' });
  }

  App.events.on('route', (name) => { if (name === 'messages') load(); });
  App.events.on('dm:new', () => { if (App.current === 'messages') load(); });
  load();
}
