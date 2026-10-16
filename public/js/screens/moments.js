/* Moments — the social feed: posts, likes, comments. */

import { $, el, toast, svg, ICON, ago, shortId, haptic } from '../util.js';
import { api } from '../api.js';

export function mountMoments(App) {
  const list = $('#momentsList');
  let loaded = false;

  async function load() {
    list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--ink-3);font-size:13px">Loading moments…</div>';
    try {
      const { moments } = await api.moments();
      render(moments);
      loaded = true;
    } catch (e) {
      list.innerHTML = `<div style="padding:40px;text-align:center;color:var(--ink-3);font-size:13px">${e.message}</div>`;
    }
  }

  function render(moments) {
    list.innerHTML = '';
    if (!moments.length) {
      list.append(el('div', { class: 'empty-state' },
        el('div', { class: 'empty-emoji', text: '✨' }),
        el('h3', { text: 'No moments yet' }),
        el('p', { text: 'Share what is happening in your rooms — photos, wins, shout-outs.' }),
        el('button', { class: 'btn btn--primary', text: 'Post a moment', onclick: compose }),
      ));
      return;
    }

    moments.forEach((m, i) => {
      const node = el('article', { class: 'moment', style: { animationDelay: `${Math.min(i, 8) * 30}ms` } });

      node.append(el('div', { class: 'moment-head' },
        el('img', { class: 'avatar avatar--md', src: m.user.avatar, alt: '', loading: 'lazy' }),
        el('div', { class: 'moment-head-info' },
          el('div', { class: 'moment-name' },
            el('span', { text: m.user.displayName }),
            m.user.vip ? el('span', { class: 'vip-badge', text: 'VIP' }) : null,
            el('span', { class: 'lvl-badge', text: 'Lv.' + m.user.level }),
          ),
          el('div', { class: 'moment-time', text: ago(m.createdAt) }),
        ),
      ));

      if (m.body) node.append(el('p', { class: 'moment-body', text: m.body }));
      if (m.media) node.append(el('img', { class: 'moment-media', src: m.media, alt: '', loading: 'lazy' }));

      const likeBtn = el('button', {
        class: 'moment-act' + (m.liked ? ' is-on' : ''),
        html: svg(ICON.heart, { width: 17, height: 17 }) + `<span>${m.likes}</span>`,
      });
      likeBtn.addEventListener('click', async () => {
        haptic();
        try {
          const res = await api.likeMoment(m.id);
          likeBtn.classList.toggle('is-on', res.liked);
          likeBtn.innerHTML = svg(ICON.heart, { width: 17, height: 17 }) + `<span>${res.likes}</span>`;
        } catch (e) { toast(e.message, 'err'); }
      });

      const commentBtn = el('button', {
        class: 'moment-act',
        html: svg(ICON.comment, { width: 17, height: 17 }) + `<span>${m.comments}</span>`,
      });
      commentBtn.addEventListener('click', () => openComments(m, commentBtn));

      node.append(el('div', { class: 'moment-actions' },
        likeBtn,
        commentBtn,
        el('button', {
          class: 'moment-act',
          html: svg(ICON.share, { width: 16, height: 16 }) + '<span>Share</span>',
          onclick: async () => {
            try {
              if (navigator.share) await navigator.share({ title: 'MK Malik', text: m.body, url: location.href });
              else { await navigator.clipboard.writeText(m.body); toast('Copied', 'ok'); }
            } catch (_) {}
          },
        }),
        m.roomId ? el('button', {
          class: 'moment-act',
          style: { marginLeft: 'auto', color: 'var(--accent)' },
          text: 'Join room →',
          onclick: () => App.events.emit('room:open', { roomId: m.roomId }),
        }) : null,
      ));

      list.append(node);
    });
  }

  // ── comments ─────────────────────────────────────────────────────────────
  async function openComments(moment, btn) {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '';
    panel.append(el('div', { class: 'sheet-grip' }), el('div', { class: 'sheet-title', text: 'Comments' }));

    const body = el('div', { class: 'sheet-list', style: { maxHeight: '46vh', overflowY: 'auto' } });
    panel.append(body);

    const inputRow = el('form', { style: { display: 'flex', gap: '8px', padding: '12px 16px 0' } });
    const input = el('input', {
      type: 'text', placeholder: 'Add a comment…', maxlength: 200,
      style: {
        flex: '1', height: '42px', padding: '0 15px', borderRadius: '999px',
        border: '1.5px solid var(--line)', background: 'var(--surface-2)', fontSize: '14px', outline: '0',
      },
    });
    const send = el('button', { class: 'btn btn--primary', type: 'submit', style: { padding: '0 18px' } }, 'Post');
    inputRow.append(input, send);
    panel.append(inputRow);

    async function draw() {
      body.innerHTML = '<div style="padding:18px;text-align:center;color:var(--ink-3);font-size:13px">Loading…</div>';
      try {
        const { comments } = await api.momentComments(moment.id);
        body.innerHTML = '';
        if (!comments.length) {
          body.innerHTML = '<div style="padding:18px;text-align:center;color:var(--ink-3);font-size:13px">No comments yet — be the first</div>';
          return;
        }
        comments.forEach((c) => body.append(el('div', { class: 'chat-msg', style: { padding: '8px 12px' } },
          el('img', { src: c.user.avatar, alt: '', style: { width: '30px', height: '30px', borderRadius: '50%' } }),
          el('div', { class: 'chat-msg-body' },
            el('div', { class: 'chat-msg-name', style: { color: 'var(--ink-3)' }, text: c.user.displayName + ' · ' + ago(c.createdAt) }),
            el('div', { class: 'chat-msg-text', style: { background: 'var(--surface-2)', color: 'var(--ink)', fontSize: '13.5px' }, text: c.body }),
          ),
        )));
      } catch (e) {
        body.innerHTML = `<div style="padding:18px;text-align:center;color:var(--ink-3);font-size:13px">${e.message}</div>`;
      }
    }

    inputRow.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        await api.addComment(moment.id, text);
        draw();
        const n = Number(btn.querySelector('span')?.textContent || 0) + 1;
        btn.innerHTML = svg(ICON.comment, { width: 17, height: 17 }) + `<span>${n}</span>`;
      } catch (e) { toast(e.message, 'err'); }
    });

    sheet.hidden = false;
    draw();
  }

  // ── composer ─────────────────────────────────────────────────────────────
  function compose() {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '';

    const textarea = el('textarea', {
      maxlength: 500, placeholder: 'What is happening?',
      style: {
        width: 'calc(100% - 40px)', height: '104px', margin: '0 20px 12px', padding: '13px 15px',
        borderRadius: '14px', border: '1.5px solid var(--line)', background: 'var(--surface-2)',
        fontSize: '15px', outline: '0', resize: 'none', fontFamily: 'inherit',
      },
    });

    const fileLabel = el('label', {
      class: 'sheet-row',
      style: { cursor: 'pointer' },
    },
      el('span', { class: 'menu-ic', html: svg(ICON.plus, { width: 17, height: 17 }) }),
      el('span', { class: 'sheet-row-main' },
        el('span', { class: 'sheet-row-label', text: 'Add a photo' }),
        el('span', { class: 'sheet-row-hint', id: 'photoHint', text: 'JPEG, PNG or WebP' }),
      ),
    );
    const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
    fileLabel.append(fileInput);
    let chosenFile = null;
    fileInput.addEventListener('change', () => {
      chosenFile = fileInput.files?.[0] || null;
      const hint = fileLabel.querySelector('#photoHint');
      if (hint) hint.textContent = chosenFile ? chosenFile.name.slice(0, 40) : 'JPEG, PNG or WebP';
    });

    const submit = el('button', { class: 'btn btn--primary btn--block', style: { margin: '14px 20px 0', width: 'calc(100% - 40px)' } }, 'Post moment');
    submit.addEventListener('click', async () => {
      const body = textarea.value.trim();
      if (!body && !chosenFile) return toast('Write something or add a photo', 'err');
      submit.disabled = true;
      submit.textContent = 'Posting…';
      try {
        const fd = new FormData();
        if (body) fd.append('body', body);
        if (chosenFile) fd.append('image', chosenFile);
        await api.postMoment(fd);
        sheet.hidden = true;
        toast('Moment posted', 'ok');
        load();
      } catch (e) {
        toast(e.message, 'err');
        submit.disabled = false;
        submit.textContent = 'Post moment';
      }
    });

    panel.append(
      el('div', { class: 'sheet-grip' }),
      el('div', { class: 'sheet-title', text: 'New moment' }),
      el('div', { class: 'sheet-sub', text: 'Your followers will see this in their feed.' }),
      textarea,
      el('div', { class: 'sheet-list' }, fileLabel),
      submit,
    );
    sheet.hidden = false;
    setTimeout(() => textarea.focus(), 220);
  }

  $('#btnMomentCompose')?.addEventListener('click', compose);
  App.events.on('moments:refresh', load);
  if (App.current === 'moments' || !loaded) load();

  return { load };
}
