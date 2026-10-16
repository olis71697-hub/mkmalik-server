/* Chat — 1:1 direct message threads. */

import { $, el, toast, svg, ICON, ago, clockLabel, haptic } from '../util.js';
import { api } from '../api.js';

export function mountChat(App) {
  const list = $('#convList');
  const dot = $('#chatDot');
  let openThreadWith = null;

  async function load() {
    try {
      const { conversations } = await api.conversations();
      render(conversations);
      const unread = conversations.reduce((s, c) => s + (c.unread || 0), 0);
      if (dot) {
        dot.hidden = unread === 0;
        dot.textContent = unread > 9 ? '9+' : String(unread);
      }
    } catch (e) {
      list.innerHTML = `<div style="padding:40px;text-align:center;color:var(--ink-3);font-size:13px">${e.message}</div>`;
    }
  }

  function render(conversations) {
    list.innerHTML = '';
    if (!conversations.length) {
      list.append(el('div', { class: 'empty-state' },
        el('div', { class: 'empty-emoji', text: '💬' }),
        el('h3', { text: 'No messages yet' }),
        el('p', { text: 'Open a room, tap someone on a mic seat and say hello.' }),
        el('button', { class: 'btn btn--primary', text: 'Find people', onclick: () => App.events.emit('route:go', 'explore') }),
      ));
      return;
    }

    conversations.forEach((c, i) => {
      list.append(el('button', {
        class: 'conv',
        style: { animationDelay: `${Math.min(i, 8) * 24}ms` },
        onclick: () => openThread(c.other),
      },
        el('img', { class: 'avatar avatar--md', src: c.other.avatar, alt: '', loading: 'lazy' }),
        el('div', { class: 'conv-main' },
          el('div', { class: 'conv-top' },
            el('span', { class: 'conv-name', text: c.other.displayName }),
            el('span', { class: 'conv-time', text: ago(c.lastAt) }),
          ),
          el('div', { class: 'conv-last', text: c.lastBody || 'Say hello 👋' }),
        ),
        c.unread ? el('span', { class: 'conv-unread', text: String(c.unread) }) : null,
      ));
    });
  }

  // ── thread view ──────────────────────────────────────────────────────────
  function openThread(other) {
    haptic();
    openThreadWith = other.id;

    const node = el('div', { class: 'dm' });
    const body = el('div', { class: 'dm-body' });

    node.append(
      el('div', { class: 'dm-head' },
        el('button', {
          class: 'icon-btn', html: svg(ICON.back, { width: 20, height: 20 }),
          onclick: () => closeThread(),
        }),
        el('img', { class: 'avatar avatar--sm', src: other.avatar, alt: '' }),
        el('div', { style: { flex: '1', minWidth: '0' } },
          el('div', { class: 'dm-head-name', text: other.displayName }),
          el('div', { style: { fontSize: '11.5px', color: 'var(--ink-3)' }, text: `@${other.username} · Lv.${other.level}` }),
        ),
        el('button', {
          class: 'icon-btn', html: svg(ICON.user, { width: 19, height: 19 }),
          onclick: () => { closeThread(); App.events.emit('view-profile', other.id); },
        }),
      ),
      body,
    );

    const input = el('input', { type: 'text', placeholder: 'Write a message…', maxlength: 500, autocomplete: 'off' });
    const form = el('form', { class: 'dm-input' },
      input,
      el('button', { class: 'send-btn', type: 'submit', html: svg(ICON.send, { width: 18, height: 18 }) }),
    );
    node.append(form);

    function bubble(msg) {
      const mine = msg.fromId === App.user?.id;
      return el('div', { class: 'dm-row' + (mine ? ' is-me' : ''), 'data-id': msg.id },
        el('div', { class: 'dm-bubble' },
          el('span', { text: msg.body }),
          el('span', {
            style: { display: 'block', fontSize: '9.5px', opacity: '.6', marginTop: '3px', textAlign: 'right' },
            text: clockLabel(msg.createdAt),
          }),
        ),
      );
    }

    async function draw() {
      body.innerHTML = '<div style="text-align:center;color:var(--ink-3);font-size:13px;padding:20px">Loading…</div>';
      try {
        const { messages } = await api.thread(other.id);
        body.innerHTML = '';
        if (!messages.length) {
          body.append(el('div', { style: { textAlign: 'center', color: 'var(--ink-3)', fontSize: '13px', padding: '24px' } },
            `Start the conversation with ${other.displayName}`));
        }
        messages.forEach((m) => body.append(bubble(m)));
        requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
        load();
      } catch (e) {
        body.innerHTML = `<div style="text-align:center;color:var(--ink-3);font-size:13px;padding:20px">${e.message}</div>`;
      }
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      const optimistic = bubble({ id: 'tmp-' + Date.now(), fromId: App.user.id, body: text, createdAt: Date.now() });
      body.append(optimistic);
      body.scrollTop = body.scrollHeight;
      try {
        await api.sendDM(other.id, text);
        load();
      } catch (e) {
        optimistic.remove();
        toast(e.message, 'err');
      }
    });

    function closeThread() { node.remove(); openThreadWith = null; load(); }

    document.getElementById('app').append(node);
    draw();
    setTimeout(() => input.focus(), 120);
  }

  // incoming DMs — bind once per socket instance
  let chatSocket = null;
  App.events.on('socket', () => {
    const s = App.socket;
    if (!s || chatSocket === s) return;
    chatSocket = s;
    s.on('dm:new', ({ message, from }) => {
      if (openThreadWith !== message.fromId) {
        toast(`💬 ${from?.displayName || 'New message'}: ${message.body.slice(0, 40)}`);
      }
      load();
    });
  });

  App.events.on('dm:open', async (userId) => {
    try {
      const { user } = await api.user(userId);
      openThread(user);
    } catch (e) { toast(e.message, 'err'); }
  });

  App.events.on('route', (name) => { if (name === 'chat') load(); });

  $('#btnNewChat')?.addEventListener('click', () => toast('Tap a person in a room to start a chat'));

  load();
  return { load, openThread };
}
