/* Secondary screens ("pages") — pushed onto a stack over the main app:
 * notifications, leaderboard, settings, privacy, edit profile, user profile,
 * followers/following, chat thread, report, help, terms, create room. */

import { $, $$, el, toast, svg, ICON, compact, ago, clockLabel, avatarImg, confirmBox, haptic, categoryEmoji, CATEGORIES, roomCover } from '../util.js';
import { t, isBn, agoLabel, setLang, lang, onLangChange } from '../i18n.js';
import { api, session } from '../api.js';
import { rel } from '../runtime.js';

/* ═══════════════ page stack ═══════════════ */
const layer = () => document.getElementById('pageLayer');
const stack = [];

/** namespace for every secondary screen — screens attach below */
export const openPage = {};

export function pushPage(title, build, { onBack } = {}) {
  const page = el('div', { class: 'page' },
    el('div', { class: 'page-top' },
      el('button', {
        class: 'icon-btn', html: svg(ICON.back),
        onclick: () => { haptic(6); closePage(page); onBack?.(); },
      }),
      el('h1', { text: title })),
    el('div', { class: 'page-body' }));
  layer().append(page);
  stack.push(page);
  build(page.querySelector('.page-body'), page);
  return page;
}

function closePage(page) {
  const i = stack.indexOf(page);
  if (i >= 0) stack.splice(i, 1);
  page.remove();
}

function popAll() { while (stack.length) stack.pop().remove(); }

/* ═══════════════ notifications ═══════════════ */
openPage.notifications = (App) => {
  pushPage(t('notifications'), async (body, page) => {
    body.append(el('div', { class: 'spin' }));
    try {
      const r = await api.notifications();
      body.innerHTML = '';
      App.unread.notifications = 0;
      import('../app.js').then(({ refreshBadges }) => refreshBadges());

      body.append(el('div', { style: { textAlign: 'right', padding: '0 4px 8px' } },
        el('button', { class: 'btn btn--ghost btn--sm', text: t('markAllRead'), onclick: async () => {
          await api.readNotifications();
          body.querySelectorAll('.notif-row').forEach((n) => n.classList.remove('is-unread'));
        } })));

      const ICONS = { follow: '👥', gift: '🎁', message: '💬', levelup: '🎉', report: '🚩', like: '❤️', comment: '💬', live: '🔴', system: '🔔' };
      if (!r.notifications?.length) {
        body.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '🔔' }), el('h3', { text: t('empty') })));
        return;
      }
      const list = el('div', { class: 'list-card' });
      r.notifications.forEach((n) => {
        const row = el('div', { class: 'notif-row' + (n.seen ? '' : ' is-unread') },
          el('div', { class: 'n-icon', text: ICONS[n.kind] || '🔔' }),
          el('div', { class: 'n-body' },
            el('div', { class: 'n-t', text: n.title }),
            el('div', { class: 'n-b', text: n.body })),
          el('span', { class: 'n-time', text: agoLabel(n.createdAt) }));
        // "X is live" notifications jump straight into the room
        if (n.meta?.roomId) {
          row.style.cursor = 'pointer';
          row.onclick = () => {
            closePage(page);
            import('./room.js').then(({ openRoom }) => openRoom(App, n.meta.roomId));
          };
        }
        list.append(row);
      });
      body.append(list);
    } catch (e) {
      body.innerHTML = '';
      body.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '📡' }), el('p', { text: e.message })));
    }
  });
};

/* ═══════════════ leaderboard ═══════════════ */
openPage.leaderboard = (App) => {
  pushPage('🏆 ' + t('leaderboard'), (body, page) => {
    let period = 'day';
    const seg = el('div', { class: 'seg', style: { margin: '4px 0 12px' } });
    const lists = el('div');
    function renderSeg() {
      seg.innerHTML = '';
      [['day', t('today')], ['week', t('week')], ['month', t('month')]].forEach(([id, label]) => {
        seg.append(el('button', { class: id === period ? 'is-active' : '', text: label, onclick: () => { period = id; renderSeg(); load(); } }));
      });
    }
    async function load() {
      lists.innerHTML = '';
      lists.append(el('div', { class: 'spin' }));
      try {
        const r = await api.leaderboard(period);
        lists.innerHTML = '';

        const section = (title, rows, field, emoji) => {
          if (!rows?.length) return;
          lists.append(el('div', { class: 'section-head' }, el('h2', { text: emoji + ' ' + title })));
          // podium for top 3
          if (rows.length >= 3) {
            const pod = el('div', { class: 'lb-podium' });
            const order = [rows[1], rows[0], rows[2]];
            order.forEach((u, i) => {
              const cls = i === 1 ? 'p1' : i === 0 ? 'p2' : 'p3';
              pod.append(el('div', { class: 'lb-pod ' + cls, onclick: () => openPage.userProfile(App, u.id) },
                el('span', { class: 'rank', text: i === 1 ? '🥇' : i === 0 ? '🥈' : '🥉' }),
                avatarImg(u.avatar, u.display_name || u.displayName),
                el('span', { class: 'nm', text: u.display_name || u.displayName }),
                el('span', { class: 'pts', text: compact(u[field] || 0) + ' 🪙' })));
            });
            lists.append(pod);
          }
          rows.slice(3).forEach((u, i) => {
            lists.append(el('div', { class: 'lb-row', onclick: () => openPage.userProfile(App, u.id) },
              el('span', { class: 'rk', text: String(i + 4) }),
              avatarImg(u.avatar, u.display_name || u.displayName, 'avatar--sm'),
              el('div', { class: 'meta' }, el('div', { class: 'nm', text: u.display_name || u.displayName }),
                el('div', { style: { fontSize: '11px', color: 'var(--text-faint)' }, text: 'Lv ' + (u.level || 1) })),
              el('span', { class: 'pts', html: svg(ICON.coin) + ' ' + compact(u[field] || 0) })));
          });
        };
        section(t('topHosts'), r.hosts, 'earned', '👑');
        section(t('topGivers'), r.givers, 'spent', '🎁');
        section(t('topReceivers'), r.receivers, 'received', '💫');
      } catch (e) {
        lists.innerHTML = '';
        lists.append(el('div', { class: 'empty-state' }, el('p', { text: e.message })));
      }
    };
    body.append(seg, lists);
    renderSeg();
    load();
  });
};

/* ═══════════════ download / install the app ═══════════════ */
openPage.install = (App) => {
  pushPage('📱 ' + t('downloadApp'), async (body, page) => {
    let appmod = null;
    try { appmod = await import('../app.js'); } catch (_) { /* page still works */ }
    const standalone = !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone);
    const ua = navigator.userAgent || '';
    const isIOS = /iphone|ipad|ipod/i.test(ua);
    const isAndroid = /android/i.test(ua);
    const isFirefoxDesktop = /firefox/i.test(ua) && !isAndroid;

    function render() {
      body.innerHTML = '';
      body.append(el('div', { class: 'install-hero' },
        el('img', { src: rel('icons/icon-192.png'), alt: 'Panda Voice' }),
        el('div', { class: 'ih-name', text: 'Panda Voice 🐼' }),
        el('div', { class: 'ih-sub', text: isBn() ? 'রিয়েল-টাইম গ্রুপ ভয়েস রুম 🎙️' : 'Real-time group voice rooms 🎙️' })));

      // ── the app link: copy / share it to your phone ──
      if (!standalone) {
        const url = location.origin + location.pathname;
        const linkCard = el('div', { class: 'list-card', style: { padding: '12px 14px', display: 'flex', gap: '10px', alignItems: 'center' } },
          el('div', { style: { flex: '1', minWidth: '0' } },
            el('div', { style: { fontWeight: 800, fontSize: '13px' }, text: '🔗 ' + t('appLink') }),
            el('div', { style: { fontSize: '11.5px', color: 'var(--text-dim)', wordBreak: 'break-all', marginTop: '2px' }, text: url }),
            el('div', { style: { fontSize: '11px', color: 'var(--text-faint)', marginTop: '4px' }, text: t('appLinkNote') })),
          el('button', {
            class: 'btn btn--ghost', style: { flexShrink: '0', fontSize: '12px' }, text: '📋 ' + t('copy'),
            onclick: async () => {
              let ok = false;
              try { await navigator.clipboard.writeText(url); ok = true; } catch (_) {
                const ta = el('textarea', { value: url, style: { position: 'fixed', opacity: '0' } });
                document.body.append(ta); ta.select();
                try { ok = document.execCommand('copy'); } catch (_) {}
                ta.remove();
              }
              toast(ok ? t('copied') : url, ok ? 'ok' : '');
              haptic(8);
            },
          }));
        if (navigator.share) {
          linkCard.append(el('button', {
            class: 'btn btn--ghost', style: { flexShrink: '0', fontSize: '12px' }, text: '📤 ' + t('share'),
            onclick: () => { try { navigator.share({ title: 'Panda Voice 🐼', url }).catch(() => {}); } catch (_) {} },
          }));
        }
        body.append(linkCard);
      }

      const card = el('div', { class: 'list-card', style: { padding: '16px 14px' } });

      if (standalone) {
        card.append(
          el('div', { class: 'install-done', text: '✓' }),
          el('div', { style: { textAlign: 'center', fontWeight: 800, marginTop: '8px' }, text: t('alreadyInstalled') }),
          el('div', { style: { textAlign: 'center', fontSize: '12px', color: 'var(--text-faint)', marginTop: '4px' }, text: t('alreadyInstalledNote') }));
      } else if (appmod?.installAvailable?.()) {
        const btn = el('button', { class: 'btn btn--primary btn--block', text: '⬇️ ' + t('installNow') });
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = '⏳ ' + t('loading');
          const outcome = await appmod.triggerInstall();
          if (outcome === 'accepted') {
            toast(t('installDone'), 'ok');
            haptic(30);
            render();
          } else {
            btn.disabled = false;
            btn.textContent = '⬇️ ' + t('installNow');
          }
        };
        card.append(btn,
          el('div', { class: 'center-note', style: { marginTop: '10px', fontSize: '11.5px' }, text: t('installOneTap') }));
      } else {
        card.append(el('div', { style: { fontWeight: 800, marginBottom: '8px' }, text: t('manualStepsTitle') }));
        const step = (n, txt) => el('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '7px 0' } },
          el('span', { style: {
            minWidth: '22px', height: '22px', borderRadius: '50%', flexShrink: '0',
            background: 'var(--brand-2, #22c55e)', color: '#04140c', fontWeight: 800,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px',
          }, text: String(n) }),
          el('span', { style: { fontSize: '13px', lineHeight: 1.55 }, text: txt }));
        if (isIOS) {
          card.append(
            step(1, isBn() ? 'Safari-র নিচের Share (⬆️) বাটনে চাপুন' : "Tap Safari's Share button (⬆️)"),
            step(2, isBn() ? 'লিস্ট থেকে "Add to Home Screen" বেছে নিন' : 'Choose "Add to Home Screen"'),
            step(3, isBn() ? '"Add" চাপুন — হোম স্ক্রিনে 🐼 বসে যাবে' : 'Tap "Add" — the 🐼 lands on your home screen'));
        } else if (isFirefoxDesktop) {
          card.append(
            step(1, isBn() ? 'অ্যাড্রেস বারের ⓘ আইকনে ক্লিক করুন' : 'Click the ⓘ icon next to the address bar'),
            step(2, isBn() ? '"Install" বাটনে চাপুন' : 'Click the "Install" button'));
        } else if (isAndroid) {
          card.append(
            step(1, isBn() ? 'Chrome-এর ডান-উপরের ⋮ মেনু খুলুন' : "Open Chrome's ⋮ menu (top right)"),
            step(2, isBn() ? '"Install app" / "অ্যাপ ইনস্টল করুন"-এ চাপুন' : 'Tap "Install app"'),
            step(3, isBn() ? 'প্রম্পট এলে "ইনস্টল" নিশ্চিত করুন' : 'Confirm "Install" when the prompt appears'));
        } else {
          card.append(
            step(1, isBn() ? 'ব্রাউজারের ⋮ বা ☰ মেনু খুলুন' : "Open the browser's ⋮ or ☰ menu"),
            step(2, isBn() ? '"Install app" / "Install Panda Voice"-এ চাপুন' : 'Tap "Install app" / "Install Panda Voice"'));
        }
      }
      body.append(card);

      body.append(el('div', { class: 'section-head' }, el('h2', { text: '✨ ' + t('installBenefits') })));
      const bcard = el('div', { class: 'list-card', style: { padding: '6px 14px' } });
      t('benefitList').split('·').map((s) => s.trim()).filter(Boolean).forEach((b) => {
        bcard.append(el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', padding: '9px 0', fontSize: '13px' } },
          el('span', { text: '✓', style: { color: 'var(--brand-2, #22c55e)', fontWeight: 800 } }),
          el('span', { text: b })));
      });
      body.append(bcard);
    }

    render();

    // Chrome can fire beforeinstallprompt while this page is open — re-render live
    const off = App.events.on('install-available', () => render());
    // and stop listening once the page is gone (back button or scrim)
    const observer = new MutationObserver(() => {
      if (!document.contains(page)) { off(); observer.disconnect(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
};

/* ═══════════════ my rooms — host analytics ═══════════════ */
openPage.myRooms = (App) => {
  pushPage('🎤 ' + t('myRooms'), async (body, page) => {
    body.append(el('div', { class: 'spin' }));
    try {
      const r = await api.myRooms();
      body.innerHTML = '';
      const s = r.summary || {};

      // summary chips
      const chip = (v, l) => el('div', { style: { flex: 1, textAlign: 'center', padding: '12px 6px', background: 'var(--bg)', borderRadius: '14px' } },
        el('b', { text: compact(v), style: { fontSize: '17px', display: 'block' } }),
        el('span', { text: l, style: { fontSize: '10.5px', color: 'var(--text-faint)' } }));
      body.append(el('div', { style: { display: 'flex', gap: '8px', margin: '6px 0 14px' } },
        chip(s.totalRooms, t('totalRooms')),
        chip(s.totalJoined, t('totalListeners')),
        chip(s.giftCoins, t('giftEarnings'))));

      if (!r.rooms?.length) {
        body.append(el('div', { class: 'empty-state' },
          el('div', { class: 'empty-emoji', text: '🎤' }),
          el('h3', { text: t('empty') }),
          el('p', { text: t('hostRoomsEmpty') }),
          el('button', { class: 'btn btn--primary', text: '🎤 ' + t('createRoom'), onclick: () => openPage.createRoom(App) })));
        return;
      }

      const card = el('div', { class: 'list-card' });
      r.rooms.forEach((rm) => {
        const row = el('div', { class: 'list-row', style: { cursor: rm.isLive ? 'pointer' : 'default' } },
          el('span', { class: 'li-icon', text: categoryEmoji(rm.category) || '🎙️' }),
          el('span', { class: 'li-body' },
            el('span', { class: 'li-t' }, rm.title,
              rm.isLive ? el('span', { style: { marginLeft: '6px', fontSize: '10px', fontWeight: 800, color: '#f87171' }, text: ' ● ' + t('liveNow') }) : null),
            el('span', { class: 'li-s', text: `👥 ${compact(rm.totalJoined)} · 📈 ${compact(rm.peakUsers)} · 🪙 ${compact(rm.giftCoins)} · ${ago(rm.createdAt)}` })),
          el('span', { class: 'li-end', html: rm.isLive ? svg(ICON.chev) : (rm.isPrivate ? '🔒' : '') }));
        if (rm.isLive) {
          row.onclick = () => {
            closePage(page);
            import('./room.js').then(({ openRoom }) => openRoom(App, rm.id));
          };
        }
        card.append(row);
      });
      body.append(card);
    } catch (e) {
      body.innerHTML = '';
      body.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '📡' }), el('p', { text: e.message })));
    }
  });
};

/* ═══════════════ create room ═══════════════ */
openPage.createRoom = (App) => {
  pushPage('🎤 ' + t('createRoom'), (body, page) => {
    const name = el('input', { class: 'input', placeholder: isBn() ? 'যেমন: রাতের আড্ডা 🐼' : 'e.g. Night adda 🐼', maxlength: '60', style: { paddingLeft: '14px' } });
    const topic = el('input', { class: 'input', placeholder: isBn() ? 'রুমে কী নিয়ে কথা হবে?' : 'What is this room about?', maxlength: '120', style: { paddingLeft: '14px' } });
    const rules = el('textarea', { class: 'input', placeholder: isBn() ? '১. সবার সাথে ভালো ব্যবহার…' : '1. Be kind…' });

    let category = 'chat';
    let theme = 'bamboo';
    const catRow = el('div', { class: 'hlist' });
    CATEGORIES.filter((c) => c.id !== 'all').forEach((c) => {
      catRow.append(el('button', {
        class: 'chip' + (category === c.id ? ' is-active' : ''),
        text: categoryEmoji(c.id) + ' ' + c.label,
        onclick: () => { category = c.id; [...catRow.children].forEach((b, i) => b.classList.toggle('is-active', b.textContent.includes(c.label))); },
      }));
    });
    const themeRow = el('div', { class: 'hlist' });
    ['bamboo', 'gold', 'rose', 'ocean', 'violet', 'mint', 'sunset', 'night'].forEach((th) => {
      themeRow.append(el('button', {
        class: 'chip' + (theme === th ? ' is-active' : ''),
        text: th,
        onclick: () => { theme = th; [...themeRow.children].forEach((b) => b.classList.toggle('is-active', b.textContent === th)); },
      }));
    });

    let langSel = 'bn';
    const langRow = el('div', { class: 'seg', style: { maxWidth: '260px' } });
    [['bn', '🇧🇩 বাংলা'], ['en', '🌐 English'], ['any', '🌏 ' + (isBn() ? 'যেকোনো' : 'Any')]].forEach(([id, label]) => {
      langRow.append(el('button', { class: id === langSel ? 'is-active' : '', text: label, onclick: () => { langSel = id; [...langRow.children].forEach((b) => b.classList.remove('is-active')); langRow.children[['bn','en','any'].indexOf(id)].classList.add('is-active'); } }));
    });

    const privCheck = el('input', { type: 'checkbox' });
    const createBtn = el('button', { class: 'btn btn--primary btn--block', text: '🎙 ' + t('create') });
    createBtn.onclick = async () => {
      const title = name.value.trim();
      if (!title) { toast(t('roomName') + '?', 'err'); return; }
      createBtn.disabled = true;
      try {
        const r = await api.createRoom({
          title, topic: topic.value.trim(), rules: rules.value.trim(),
          category, theme, language: langSel, isPrivate: privCheck.checked,
        });
        toast(t('roomCreated') + (r.pin ? ` — PIN ${r.pin}` : ''), 'ok');
        closePage(page);
        import('./room.js').then(({ openRoom }) => openRoom(App, r.room.id, { pin: r.pin }));
      } catch (e) { toast(e.message, 'err'); createBtn.disabled = false; }
    };

    body.append(
      el('div', { class: 'field' }, el('label', { text: t('roomName') }), name),
      el('div', { class: 'field' }, el('label', { text: t('roomTopic') }), topic),
      el('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--text-dim)', padding: '4px 2px' }, text: t('category') }), catRow,
      el('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--text-dim)', padding: '10px 2px 2px' }, text: '🎨 ' + t('theme') }), themeRow,
      el('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--text-dim)', padding: '10px 2px 2px' }, text: t('language') }), langRow,
      el('div', { class: 'field', style: { marginTop: '12px' } }, el('label', { text: t('roomRules') }), rules),
      el('label', { class: 'terms-check' }, privCheck, el('span', { text: '🔒 ' + t('privateRoom') })),
      el('div', { style: { height: '10px' } }),
      createBtn,
    );
  });
};

/* ═══════════════ user profile ═══════════════ */
openPage.userProfile = (App, userId) => {
  pushPage(t('profile'), async (body, page) => {
    body.innerHTML = '';
    body.append(el('div', { class: 'spin' }));
    try {
      const r = await api.user(userId);
      const u = r.user;
      const isMe = App.user?.id === u.id;
      body.innerHTML = '';

      body.append(el('div', { class: 'profile-hero' },
        el('div', { class: 'profile-ava' },
          avatarImg(u.avatar, u.displayName, 'avatar--xl'),
          el('span', { class: 'lvl-float', text: `Lv ${u.level || 1}` })),
        el('div', { class: 'profile-name' },
          el('span', { text: u.displayName }),
          u.vip ? el('span', { class: 'vip', html: svg(ICON.crownS) + 'VIP' }) : null),
        el('div', { class: 'profile-id', text: `@${u.username} · ID ${u.userCode || '—'}` }),
        u.bio ? el('p', { class: 'profile-bio', text: u.bio }) : null,
        el('div', { class: 'profile-xp' },
          el('div', { class: 'bar' }, el('i', { style: { width: xpPct(u) + '%' } })),
          el('div', { class: 'lbl' }, el('span', { text: `XP ${compact(u.xp || 0)}` }), el('span', { text: `Lv ${u.level || 1} → ${u.level + 1}` }))),
        el('div', { class: 'stat-row' },
          el('div', { class: 'stat' }, el('b', { text: compact(u.followers || 0) }), el('span', { text: t('followers') })),
          el('div', { class: 'stat' }, el('b', { text: compact(u.following || 0) }), el('span', { text: t('following') })),
          el('div', { class: 'stat' }, el('b', { text: compact(u.giftsReceivedCoins || 0) }), el('span', { text: t('giftsReceived') })),
          el('div', { class: 'stat' }, el('b', { text: compact(u.giftsSentCoins || 0) }), el('span', { text: t('giftsSent') })))));

      const actions = el('div', { class: 'profile-actions' });
      if (!isMe) {
        const followBtn = el('button', { class: 'btn ' + (u.isFollowing ? 'btn--ghost' : 'btn--primary'), text: u.isFollowing ? t('unfollow') : t('follow') });
        followBtn.onclick = async () => {
          try {
            const fr = await api.follow(u.id);
            u.isFollowing = fr.following;
            followBtn.textContent = fr.following ? t('unfollow') : t('follow');
            followBtn.className = 'btn ' + (fr.following ? 'btn--ghost' : 'btn--primary');
          } catch (e) { toast(e.message, 'err'); }
        };
        actions.append(followBtn,
          el('button', { class: 'btn btn--ghost', text: '💬 ' + t('message'), onclick: () => { closePage(page); openPage.chatThread(App, u.id, u); } }));
        if (u.blocked) {
          actions.append(el('button', { class: 'btn btn--ghost', text: t('unblock'), onclick: async () => { await api.unblock(u.id); u.blocked = false; toast(t('unblock') + ' ✓'); page.remove(); openPage.userProfile(App, userId); } }));
        } else {
          actions.append(el('button', { class: 'btn btn--ghost', text: '🚫 ' + t('block'), onclick: async () => {
            const yes = await confirmBox({ title: t('block') + '?', body: u.displayName, okLabel: t('block'), danger: true });
            if (yes) { await api.block(u.id); toast(t('blocked') + ' ✓'); page.remove(); openPage.userProfile(App, userId); }
          } }));
        }
        actions.append(el('button', { class: 'btn btn--danger', text: '🚩 ' + t('report'), onclick: () => openPage.report(App, 'user', u.id, u.displayName) }));
      } else {
        actions.append(el('button', { class: 'btn btn--primary', text: '✏️ ' + t('editProfile'), onclick: () => { closePage(page); openPage.editProfile(App); } }));
      }
      body.append(actions);

      // gift history
      const giftsR = await api.userGifts(u.id).catch(() => ({ gifts: [] }));
      if (giftsR.gifts?.length) {
        body.append(el('div', { class: 'section-head' }, el('h2', { text: '🎁 ' + t('giftHistory') }), el('span', { class: 'count', text: compact(giftsR.total || 0) + ' 🪙' })));
        const card = el('div', { class: 'list-card' });
        giftsR.gifts.slice(0, 12).forEach((g) => {
          card.append(el('div', { class: 'tx-row' },
            el('div', { class: 'tx-icon', text: g.emoji }),
            el('div', { class: 'meta' }, el('div', { class: 't1', text: `${g.from?.displayName || '—'} → ${g.name} ×${g.qty}` }), el('div', { class: 't2', text: agoLabel(g.createdAt) })),
            el('span', { class: 'amt', text: String(g.coins) })));
        });
        body.append(card);
      }

      body.append(el('div', { class: 'center-note' }, `${t('memberSince')} ${new Date(u.createdAt).toLocaleDateString(isBn() ? 'bn-BD' : 'en-GB')}`));
    } catch (e) {
      body.innerHTML = '';
      body.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '🐼' }), el('p', { text: e.message })));
    }
  });
};

const xpPct = (u) => Math.max(4, Math.min(100, Math.round(((u.xp || 0) - (u.xpFloor || 0)) / Math.max(1, (u.xpNext || 100) - (u.xpFloor || 0)) * 100)));

/* ═══════════════ edit profile ═══════════════ */
openPage.editProfile = (App) => {
  pushPage(t('editProfile'), (body, page) => {
    const u = App.user;
    const name = el('input', { class: 'input', value: u.displayName || '', maxlength: '24', style: { paddingLeft: '14px' } });
    const bio = el('textarea', { class: 'input', maxlength: '200' });
    bio.value = u.bio || '';
    const genderSel = el('select', { class: 'input', style: { paddingLeft: '14px' } },
      ...[['any', t('any')], ['male', t('male')], ['female', t('female')], ['other', t('other')]].map(([v, l]) => el('option', { value: v, text: l, selected: (u.gender || 'any') === v })));
    const country = el('input', { class: 'input', value: u.country || '', placeholder: isBn() ? 'যেমন: বাংলাদেশ' : 'e.g. Bangladesh', style: { paddingLeft: '14px' } });

    // avatar picker
    const avaWrap = el('div', { style: { textAlign: 'center', padding: '6px 0 16px' } });
    const ava = avatarImg(u.avatar, u.displayName, 'avatar--xl');
    const pick = async () => {
      const input = el('input', { type: 'file', accept: 'image/*' });
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const r = await api.uploadAvatar(file);
          ava.src = r.user.avatar;
          App.setUser(r.user);
          toast(t('saved') + ' ✓', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      input.click();
    };
    const pickBtn = el('button', { class: 'btn btn--ghost btn--sm', style: { marginTop: '8px' }, html: svg(ICON.camera) + ' ' + t('changePhoto'), onclick: pick });
    ava.style.margin = '0 auto';
    avaWrap.append(ava, pickBtn);

    const save = el('button', { class: 'btn btn--primary btn--block', text: t('save') });
    save.onclick = async () => {
      save.disabled = true;
      try {
        const r = await api.updateMe({ displayName: name.value.trim(), bio: bio.value.trim(), gender: genderSel.value, country: country.value.trim() });
        App.setUser(r.user);
        toast(t('saved') + ' ✓', 'ok');
        closePage(page);
      } catch (e) { toast(e.message, 'err'); save.disabled = false; }
    };

    body.append(
      avaWrap,
      el('div', { class: 'field' }, el('label', { text: t('displayName') }), name),
      el('div', { class: 'field' }, el('label', { text: t('bio') }), bio),
      el('div', { class: 'field' }, el('label', { text: t('gender') }), genderSel),
      el('div', { class: 'field' }, el('label', { text: t('country') }), country),
      save,
    );
  });
};

/* ═══════════════ followers / following ═══════════════ */
openPage.followList = (App, userId, which, title) => {
  pushPage(title, async (body) => {
    body.append(el('div', { class: 'spin' }));
    try {
      const r = which === 'followers' ? await api.followers(userId) : await api.following(userId);
      body.innerHTML = '';
      if (!r.users?.length) { body.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '👥' }), el('h3', { text: t('empty') }))); return; }
      const card = el('div', { class: 'list-card', style: { padding: '4px 10px' } });
      r.users.forEach((u) => {
        card.append(el('div', { class: 'user-row', onclick: () => openPage.userProfile(App, u.id) },
          avatarImg(u.avatar, u.displayName, 'avatar--sm'),
          el('div', { class: 'meta' },
            el('div', { class: 'name' }, el('span', { text: u.displayName }), u.vip ? el('span', { class: 'vip', html: svg(ICON.crownS) + 'VIP' }) : null, el('span', { class: 'lvl', text: u.level || 1 })),
            el('div', { class: 'sub' }, el('span', { text: `ID ${u.userCode || '—'} · ${compact(u.followers || 0)} ${t('followers')}` })))));
      });
      body.append(card);
    } catch (e) { body.innerHTML = ''; body.append(el('div', { class: 'empty-state' }, el('p', { text: e.message }))); }
  });
};

/* ═══════════════ chat thread ═══════════════ */
openPage.chatThread = (App, otherId, otherUser = null) => {
  pushPage(otherUser?.displayName || t('message'), async (body, page) => {
    if (!otherUser) {
      try { otherUser = (await api.user(otherId)).user; } catch (e) { body.append(el('div', { class: 'empty-state' }, el('p', { text: e.message }))); return; }
      page.querySelector('h1').textContent = otherUser.displayName;
    }
    const other = otherUser;

    const thread = el('div', { class: 'thread' });
    const form = el('form', { class: 'room-inputbar', style: { position: 'sticky', bottom: '0', background: 'var(--bg)' } },
      el('input', { type: 'text', placeholder: t('typeMessage'), maxlength: '500', autocomplete: 'off' }),
      el('button', { type: 'submit', class: 'send-btn', html: svg(ICON.send) }));
    body.append(thread, form);

    let lastDay = '';
    async function load() {
      try {
        const r = await api.thread(otherId);
        thread.innerHTML = '';
        for (const m of r.messages) {
          const day = new Date(m.createdAt).toDateString();
          if (day !== lastDay) { lastDay = day; thread.append(el('div', { class: 'day-sep', text: new Date(m.createdAt).toLocaleDateString(isBn() ? 'bn-BD' : 'en-GB', { month: 'short', day: 'numeric' }) })); }
          appendMsg(m);
        }
        body.scrollTop = body.scrollHeight;
      } catch (e) { toast(e.message, 'err'); }
    }
    function appendMsg(m) {
      const mine = m.fromId === App.user.id;
      thread.append(el('div', { class: 'bubble-row' + (mine ? ' mine' : '') },
        mine ? null : avatarImg(other.avatar, other.displayName),
        el('div', { class: 'bubble' }, el('span', { text: m.body }), el('span', { class: 'b-time', text: clockLabel(m.createdAt) }))));
    }
    form.onsubmit = (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      const optimistic = { id: 'tmp' + Date.now(), fromId: App.user.id, body: text, createdAt: Date.now() };
      appendMsg(optimistic);
      body.scrollTop = body.scrollHeight;
      if (App.socket && App.socket.connected !== false) {
        App.socket.emit('dm:send', { toUserId: otherId, body: text }, (r) => {
          if (!r?.ok) toast(r?.error || t('error'), 'err');
        });
      } else {
        api.sendDM(otherId, text).catch((err) => toast(err.message, 'err'));
      }
    };

    // live incoming
    const onDm = (p) => {
      if (p.message?.fromId === otherId) {
        appendMsg(p.message);
        body.scrollTop = body.scrollHeight;
      } else if (p.from?.id === otherId || p.message?.fromId === otherId) {
        appendMsg(p.message);
        body.scrollTop = body.scrollHeight;
      }
    };
    App.events.on('dm:new', onDm);
    page.addEventListener('remove', () => App.events.off('dm:new', onDm));
    // CustomEvent on remove doesn't exist natively; use MutationObserver-lite:
    const mo = new MutationObserver(() => { if (!document.contains(page)) { App.events.off('dm:new', onDm); mo.disconnect(); } });
    mo.observe(layer(), { childList: true });

    load();
  });
};

/* ═══════════════ new chat (pick a user) ═══════════════ */
openPage.newChat = (App) => {
  pushPage('💬 ' + t('newMessage'), async (body) => {
    body.append(el('div', { class: 'spin' }));
    try {
      const [convs, users] = await Promise.all([api.conversations(), api.users('popular')]);
      body.innerHTML = '';
      const seen = new Set(convs.conversations?.map((c) => c.other?.id) || []);
      const fresh = (users.users || []).filter((u) => !seen.has(u.id));
      const list = [...(convs.conversations?.map((c) => ({ ...c.other, lastAt: c.lastAt })) || []), ...fresh];
      if (!list.length) { body.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '💬' }), el('h3', { text: t('noConversations') }))); return; }
      const card = el('div', { class: 'list-card', style: { padding: '4px 10px' } });
      list.forEach((u) => {
        card.append(el('div', { class: 'user-row', onclick: () => openPage.chatThread(App, u.id, u) },
          avatarImg(u.avatar, u.displayName, 'avatar--sm'),
          el('div', { class: 'meta' },
            el('div', { class: 'name' }, el('span', { text: u.displayName }), u.online ? el('span', { class: 'on-dot', style: { marginLeft: '6px' } }) : null),
            el('div', { class: 'sub' }, el('span', { text: `ID ${u.userCode || '—'}` })))));
      });
      body.append(card);
    } catch (e) { body.innerHTML = ''; body.append(el('div', { class: 'empty-state' }, el('p', { text: e.message }))); }
  });
};

/* ═══════════════ report ═══════════════ */
openPage.report = (App, targetType, targetId, targetName = '') => {
  pushPage('🚩 ' + t('reportTitle'), (body, page) => {
    const REASONS = [
      ['spam', t('reasonSpam')], ['abuse', t('reasonAbuse')], ['sexual', t('reasonSexual')],
      ['violence', t('reasonViolence')], ['underage', t('reasonUnderage')], ['other', t('reasonOther')],
    ];
    let reason = 'spam';
    const reasonRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', margin: '6px 0 14px' } });
    REASONS.forEach(([id, label], i) => {
      reasonRow.append(el('button', {
        class: 'btn btn--sm ' + (i === 0 ? 'btn--primary' : 'btn--ghost'),
        text: label,
        onclick: () => { reason = id; [...reasonRow.children].forEach((b, j) => b.className = 'btn btn--sm ' + (j === i ? 'btn--primary' : 'btn--ghost')); },
      }));
    });
    const note = el('textarea', { class: 'input', placeholder: t('reportNote'), maxlength: '300' });
    const send = el('button', { class: 'btn btn--danger btn--block', text: t('report') });
    send.onclick = async () => {
      send.disabled = true;
      try {
        await api.report({ targetType, targetId, reason, note: note.value.trim() });
        toast(t('reportSent'), 'ok');
        closePage(page);
      } catch (e) { toast(e.message, 'err'); send.disabled = false; }
    };
    body.append(
      el('p', { style: { color: 'var(--text-dim)', fontSize: '13px' } }, `${targetType === 'room' ? '🎙' : '👤'} ${targetName || targetId}`),
      el('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--text-dim)' }, text: t('reportReason') }),
      reasonRow,
      el('div', { class: 'field' }, el('label', { text: t('reportNote') }), note),
      send,
    );
  });
};

/* ═══════════════ coin info ═══════════════ */
openPage.coinInfo = (App) => {
  pushPage('🪙 ' + t('coins'), (body) => {
    body.append(
      el('div', { class: 'list-card' },
        row('🎁', t('gifts'), isBn() ? 'রুমের ইউজারদের গিফট পাঠাতে কয়েন লাগে' : 'Coins buy gifts for room members'),
        row('🎁', t('giftsReceived'), isBn() ? 'প্রাপ্ত গিফট ডায়মন্ডে রূপান্তরিত হয়' : 'Received gifts convert to diamonds'),
        row('👑', 'VIP', isBn() ? '৫০০০+ ডায়মন্ড হলে VIP ব্যাজ আসলে' : 'Earn a VIP badge at 5,000+ diamonds'),
        row('🪙', t('dailyBonus'), isBn() ? 'প্রতিদিন +১৫০ কয়েন ফ্রি' : '+150 free coins every day')),
    );
    function row(icon, title, sub) {
      return el('div', { class: 'list-row' },
        el('span', { class: 'li-icon is-gold', text: icon }),
        el('span', { class: 'li-body' }, el('span', { class: 'li-t', text: title }), el('span', { class: 'li-s', text: sub })));
    }
  });
};

/* ═══════════════ settings ═══════════════ */
openPage.settings = (App) => {
  pushPage('⚙️ ' + t('settings'), async (body, page) => {
    let settings = { ...App.settings };
    try { settings = (await api.settings()).settings; } catch (_) {}
    App.settings = settings;

    const toggle = (label, key) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!settings[key];
      cb.onchange = () => { settings[key] = cb.checked ? 1 : 0; api.saveSettings(settings).then((r) => { App.settings = r.settings; }).catch(() => {}); };
      return el('label', { class: 'list-row', style: { cursor: 'pointer' } },
        el('span', { class: 'li-body' }, el('span', { class: 'li-t', text: label })),
        el('span', { class: 'switch' }, cb, el('i')));
    };

    // icon: an ICON.* key (svg path), ready svg markup, or a plain emoji
    const row = (icon, title, sub, fn, danger = false) => {
      const iconEl = el('span', { class: 'li-icon' + (danger ? ' is-danger' : '') });
      const s = String(icon);
      if (s.startsWith('<svg')) iconEl.innerHTML = s;
      else if (/\p{Extended_Pictographic}/u.test(s)) iconEl.textContent = s;
      else iconEl.innerHTML = svg(s);
      return el('button', { class: 'list-row' + (danger ? ' is-danger' : ''), onclick: fn },
        iconEl,
        el('span', { class: 'li-body' }, el('span', { class: 'li-t', text: title }), sub ? el('span', { class: 'li-s', text: sub }) : null),
        el('span', { class: 'li-end', html: svg(ICON.chev) }));
    };

    // ---- real Web Push (VAPID): subscribe THIS browser through the Push API
    const b64ToUint8 = (b64) => {
      const pad = '='.repeat((4 - (b64.length % 4)) % 4);
      const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
      return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
    };
    const pushRow = el('div', { class: 'list-row', style: { cursor: 'pointer' } });
    const buildPushRow = async () => {
      pushRow.innerHTML = '';
      const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      const title = el('span', { class: 'li-t', text: '📲 ' + (isBn() ? 'পুশ নোটিফিকেশন (Android/ডেস্কটপ)' : 'Push notifications (Android/desktop)') });
      const sub = el('span', { class: 'li-s' });
      const box = el('span', { class: 'switch' }, el('input', { type: 'checkbox' }), el('i'));
      const cb = box.querySelector('input');
      pushRow.append(el('span', { class: 'li-icon', html: svg(ICON.bell || ICON.info) }), el('span', { class: 'li-body' }, title, sub), box);

      if (!supported) {
        cb.disabled = true;
        sub.textContent = isBn() ? 'এই ব্রাউজার সাপোর্ট করে না' : 'Not supported in this browser';
        return;
      }
      let st = { enabled: false };
      try { st = await api.pushStatus(); } catch (_) {}
      cb.checked = !!st.enabled;
      sub.textContent = st.enabled
        ? (isBn() ? 'চালু — অ্যাপ বন্ধ থাকলেও নোটিফিকেশন আসবে' : 'On — notifications arrive even when closed')
        : (isBn() ? 'বন্ধ' : 'Off');

      cb.onchange = async () => {
        try {
          if (cb.checked) {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') { cb.checked = false; sub.textContent = isBn() ? 'অনুমতি দেওয়া হয়নি' : 'Permission denied'; return; }
            const reg = await navigator.serviceWorker.ready;
            const { publicKey } = await api.pushKey();
            const subn = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(publicKey) });
            await api.pushSubscribe(subn.toJSON());
            toast(isBn() ? 'পুশ নোটিফিকেশন চালু ✓' : 'Push enabled ✓');
          } else {
            const reg = await navigator.serviceWorker.ready;
            const existing = await reg.pushManager.getSubscription();
            if (existing) { await api.pushUnsubscribe(existing.endpoint); await existing.unsubscribe(); }
            toast(isBn() ? 'পুশ নোটিফিকেশন বন্ধ' : 'Push disabled');
          }
        } catch (e) {
          cb.checked = !cb.checked;
          sub.textContent = e.message || t('error');
          return;
        }
        buildPushRow();
      };
    };
    buildPushRow();

    // language + theme
    const langSeg = el('div', { class: 'seg', style: { maxWidth: '240px', margin: '4px 0 14px' } });
    [['bn', '🇧🇩 বাংলা'], ['en', '🌐 English']].forEach(([id, label]) => {
      langSeg.append(el('button', {
        class: (lang() === id ? 'is-active' : ''),
        text: label,
        onclick: () => {
          setLang(id);
          settings.language = id;
          api.saveSettings(settings).catch(() => {});
          [...langSeg.children].forEach((b) => b.classList.remove('is-active'));
          langSeg.children[id === 'bn' ? 0 : 1].classList.add('is-active');
        },
      }));
    });

    const themeSeg = el('div', { class: 'seg', style: { maxWidth: '240px', margin: '4px 0 14px' } });
    const apply = (th) => import('../app.js').then(({ applyTheme }) => { applyTheme(th); settings.theme = th; api.saveSettings(settings).catch(() => {}); });
    [['dark', '🌙 ' + t('darkMode')], ['light', '☀️ ' + t('lightMode')]].forEach(([id, label]) => {
      themeSeg.append(el('button', {
        class: ((document.documentElement.dataset.theme || 'dark') === id ? 'is-active' : ''),
        text: label,
        onclick: () => { apply(id); [...themeSeg.children].forEach((b) => b.classList.remove('is-active')); themeSeg.children[id === 'dark' ? 0 : 1].classList.add('is-active'); },
      }));
    });

    body.append(
      el('div', { class: 'section-head', style: { marginTop: '0' } }, el('h2', { text: '🌐 ' + t('language') })),
      langSeg,
      el('div', { class: 'section-head' }, el('h2', { text: '🎨 ' + t('theme') })),
      themeSeg,
      el('div', { class: 'section-head' }, el('h2', { text: '🔔 ' + t('notifications') })),
      el('div', { class: 'list-card' },
        pushRow,
        toggle(t('notifyMessages'), 'notify_message'),
        toggle(t('notifyGifts'), 'notify_gift'),
        toggle(t('notifyFollows'), 'notify_follow')),
      el('div', { class: 'section-head' }, el('h2', { text: '📱 ' + (isBn() ? 'অ্যাপ' : 'App') })),
      el('div', { class: 'list-card' },
        row('📱', t('downloadApp'), t('downloadAppNote'), () => openPage.install(App))),
      el('div', { class: 'section-head' }, el('h2', { text: '🛡 ' + t('privacy') + ' & ' + t('security') })),
      el('div', { class: 'list-card' },
        row(ICON.shield, t('privacy'), '', () => openPage.privacy(App, settings)),
        row(ICON.ban, t('blockedUsers'), '', async () => openPage.blocked(App)),
        row(ICON.lock, t('changePassword'), '', () => openPage.changePassword(App))),
      el('div', { class: 'section-head' }, el('h2', { text: '🔊 ' + t('volume') })),
      el('div', { class: 'list-card', style: { padding: '14px' } },
        (() => {
          const slider = el('input', {
            type: 'range', min: '0', max: '100', step: '5',
            style: { width: '100%', accentColor: 'var(--brand-2, #22c55e)' },
          });
          try { slider.value = String(Math.round((Number(localStorage.getItem('panda.volume') ?? 1)) * 100)); } catch (_) { slider.value = '100'; }
          slider.oninput = () => {
            const v = Number(slider.value) / 100;
            try { localStorage.setItem('panda.volume', String(v)); } catch (_) {}
            App.events.emit('volume', v);   // the live room applies it instantly
          };
          return slider;
        })()),
      el('div', { class: 'section-head' }, el('h2', { text: 'ℹ️ ' + t('about') })),
      el('div', { class: 'list-card' },
        row(ICON.help, t('helpSupport'), '', () => openPage.help(App)),
        row(ICON.info, t('termsTitle'), '', () => openPage.terms(App, 'terms')),
        row(ICON.download || ICON.info, t('downloadData'), t('downloadDataNote'), async () => {
          try {
            const data = await api.exportData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = el('a', { href: url, download: 'panda-voice-my-data.json' });
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
          } catch (e) { toast(e.message, 'err'); }
        }),
        row(ICON.info, t('cacheClear'), t('cacheClearNote'), async () => {
          if (!(await confirmBox(t('cacheClear') + '?', t('cacheClearNote')))) return;
            try { if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k); } catch (_) {}
            toast(t('cacheCleared') + ' ✓', 'ok');
        }),
        (() => {
          // the REAL version straight from the server — never hardcoded
          const verRow = row(ICON.info, t('version'), '…', () => {});
          api.health().then((h) => {
            verRow.querySelector('.li-s').textContent = `${h.version} · ${h.env} 🐼`;
          }).catch(() => { verRow.querySelector('.li-s').textContent = '—'; });
          return verRow;
        })()),
      el('div', { class: 'list-card', style: { marginTop: '14px' } },
        row(ICON.close, t('deleteAccount'), t('deleteAccountWarn'), () => openPage.deleteAccount(App), true),
        row(ICON.logout, t('logoutAll'), t('logoutAllNote'), async () => {
          // server-side: bump token_version → every session, everywhere, dies
          try { await api.logoutAll(); } catch (_) {}
          closePage(page);
          import('../app.js').then(({ signOut }) => signOut());
        }),
        row(ICON.logout, t('logout'), '', async () => { closePage(page); import('../app.js').then(({ signOut }) => signOut()); })),
    );
  });
};

/* ═══════════════ privacy page ═══════════════ */
openPage.privacy = (App, settings) => {
  pushPage('🛡 ' + t('privacy'), (body) => {
    let s = { ...settings };
    const seg = (label, key, options) => {
      const row = el('div', { class: 'list-row', style: { display: 'block' } },
        el('div', { class: 'li-t', style: { marginBottom: '8px' }, text: label }),
        el('div', { class: 'seg' }, options.map(([id, lbl]) => el('button', {
          class: s[key] === id ? 'is-active' : '',
          text: lbl,
          onclick: (e) => {
            s[key] = id;
            api.saveSettings(s).then((r) => { s = r.settings; App.settings = r.settings; }).catch(() => {});
            [...e.target.parentElement.children].forEach((b) => b.classList.remove('is-active'));
            e.target.classList.add('is-active');
          },
        }))));
      return el('div', { class: 'list-card', style: { marginBottom: '10px' } }, row);
    };
    const toggle = (label, key) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!s[key];
      cb.onchange = () => { s[key] = cb.checked ? 1 : 0; api.saveSettings(s).then((r) => { s = r.settings; }).catch(() => {}); };
      return el('label', { class: 'list-row', style: { cursor: 'pointer' } },
        el('span', { class: 'li-body' }, el('span', { class: 'li-t', text: label })),
        el('span', { class: 'switch' }, cb, el('i')));
    };
    body.append(
      seg(t('dmPrivacy'), 'dm_privacy', [['everyone', t('everyone')], ['following', t('followersOnly')], ['nobody', t('nobody')]]),
      el('div', { class: 'list-card', style: { marginBottom: '10px' } }, toggle(t('showOnline'), 'show_online')),
      el('p', { class: 'center-note', text: isBn() ? 'ডিএম প্রাইভেসি সার্ভার থেকে প্রয়োগ হয় — ব্লক করা ইউজার কখনোই মেসেজ বা গিফট পাঠাতে পারবে না।' : 'DM privacy is enforced server-side; blocked users can never message or gift you.' }),
    );
  });
};

/* ═══════════════ blocked users ═══════════════ */
openPage.blocked = (App) => {
  pushPage('🚫 ' + t('blockedUsers'), async (body) => {
    body.append(el('div', { class: 'spin' }));
    try {
      const r = await api.blocks();
      body.innerHTML = '';
      if (!r.blocked?.length) { body.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '🕊' }), el('h3', { text: t('empty') }))); return; }
      const card = el('div', { class: 'list-card', style: { padding: '4px 10px' } });
      r.blocked.forEach((u) => {
        card.append(el('div', { class: 'user-row' },
          avatarImg(u.avatar, u.displayName, 'avatar--sm'),
          el('div', { class: 'meta' }, el('div', { class: 'name' }, el('span', { text: u.displayName }))),
          el('button', { class: 'btn btn--ghost btn--sm', text: t('unblock'), onclick: async (e) => { await api.unblock(u.id); e.target.closest('.user-row').remove(); toast(t('unblock') + ' ✓'); } })));
      });
      body.append(card);
    } catch (e) { body.innerHTML = ''; body.append(el('div', { class: 'empty-state' }, el('p', { text: e.message }))); }
  });
};

/* ═══════════════ change password ═══════════════ */
openPage.changePassword = (App) => {
  pushPage('🔒 ' + t('changePassword'), (body, page) => {
    const cur = el('input', { class: 'input', type: 'password', placeholder: t('currentPassword'), style: { paddingLeft: '14px' } });
    const nw = el('input', { class: 'input', type: 'password', placeholder: t('newPassword'), style: { paddingLeft: '14px' } });
    const btn = el('button', { class: 'btn btn--primary btn--block', text: t('save') });
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.changePassword(cur.value, nw.value);
        toast(t('passwordChanged'), 'ok');
        closePage(page);
      } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
    };
    body.append(
      el('div', { class: 'field' }, el('label', { text: t('currentPassword') }), cur),
      el('div', { class: 'field' }, el('label', { text: t('newPassword') }), nw),
      btn,
    );
  });
};

/* ═══════════════ delete account ═══════════════ */
openPage.deleteAccount = (App) => {
  pushPage('🗑 ' + t('deleteAccount'), (body, page) => {
    const pw = el('input', { class: 'input', type: 'password', placeholder: t('password'), style: { paddingLeft: '14px' } });
    const btn = el('button', { class: 'btn btn--danger btn--block', text: t('deleteAccount') });
    btn.onclick = async () => {
      const yes = await confirmBox({ title: t('confirmDelete'), body: t('deleteAccountWarn'), okLabel: t('delete'), danger: true });
      if (!yes) return;
      btn.disabled = true;
      try {
        await api.deleteAccount({ password: pw.value, confirm: true });
        toast(t('accountDeleted'));
        closePage(page);
        import('../app.js').then(({ signOut }) => signOut());
      } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
    };
    body.append(
      el('p', { class: 'center-note', style: { color: 'var(--danger)', fontWeight: 700 }, text: '⚠ ' + t('deleteAccountWarn') }),
      el('div', { class: 'field' }, el('label', { text: t('password') }), pw),
      btn,
    );
  });
};

/* ═══════════════ help ═══════════════ */
openPage.help = (App) => {
  pushPage('❓ ' + t('helpSupport'), (body) => {
    const qa = [
      ['🎤 ' + (isBn() ? 'মাইক কীভাবে নেব?' : 'How do I get the mic?'), isBn() ? 'রুমে ঢুকে খালি সিটে ট্যাপ করুন বা নিচের মাইক বাটন চাপুন। সব সিট পূর্ণ থাকলে হাত তুলুন (✋) — হোস্ট সিট খালি হলে আপনাকে ডাকবে।' : 'Tap an empty seat in the room or the mic button below. If all seats are taken, raise your hand — the host can invite you.'],
      ['🔐 ' + (isBn() ? 'প্রাইভেট রুম কীভাবে যাব?' : 'How do private rooms work?'), isBn() ? 'প্রাইভেট রুমে ৬-সংখ্যার পিন লাগে। হোস্ট শেয়ার করলে সেটি দিয়ে ঢুকতে পারবেন।' : 'Private rooms need a 6-digit PIN the host shares with you.'],
      ['🪙 ' + (isBn() ? 'কয়েন কীভাবে পাব?' : 'How do I get coins?'), isBn() ? 'প্রতিদিন ডেইলি বোনাস (+১৫০), নতুন অ্যাকাউন্টে ওয়েলকাম বোনাস, আর ওয়ালেট থেকে কিনে।' : 'Daily bonus (+150), the welcome bonus, or buy them in the Wallet.'],
      ['🔇 ' + (isBn() ? 'কেউ বিরক্ত করছে?' : 'Someone bothering you?'), isBn() ? 'ইউজার প্রোফাইল থেকে Block করুন — সে আর মেসেজ/গিফট পাঠাতে পারবে না। দরকার হলে Report-ও করুন।' : 'Block them from their profile — they can no longer message or gift you. Report if needed.'],
      ['📶 ' + (isBn() ? 'ভয়েস কাটছে?' : 'Voice breaking up?'), isBn() ? 'নেটওয়ার্ক ভালো কভারেজে থাকুন। সার্ভারে TURN কনফিগার থাকলে এটি অনেক উন্নত হয় (README দেখুন)।' : 'Stay on a good network. A configured TURN server makes voice far more reliable (see the README).'],
    ];
    body.append(el('div', { class: 'list-card' }, qa.map(([q, a]) => el('div', { class: 'list-row', style: { display: 'block' } },
      el('div', { class: 'li-t', text: q }),
      el('div', { class: 'li-s', style: { whiteSpace: 'pre-wrap', lineHeight: 1.6, marginTop: '4px' }, text: a })))));
  });
};

/* ═══════════════ terms & privacy ═══════════════ */
openPage.terms = (App, which = 'terms') => {
  pushPage(t('termsTitle'), (body) => {
    const TERMS = isBn() ? `Panda Voice ব্যবহারের শর্তাবলী

১. বয়স: অ্যাপটি ১৩+ ব্যবহারকারীদের জন্য।
২. সম্মান: হয়রানি, ঘৃণা-বাণী বা অশ্লীল আচরণ নিষিদ্ধ।
৩. কনটেন্ট: আপনি নিজের কথায় দায়ী। অন্যের কপিরাইট বা ব্যক্তিগত তথ্য শেয়ার করবেন না।
৪. ভার্চুয়াল কয়েন: কয়েন কেবল অ্যাপের ভেতরের ভার্চুয়াল সম্পদ; টাকায় ফেরতযোগ্য নয় (আইনগতভাবে বাধ্যতামূলক না হলে)।
৫. নিরাপত্তা: রিপোর্ট করা হলে অ্যাকাউন্ট স্থগিত বা ব্যান হতে পারে।
৬. পরিবর্তন: শর্তাবলী আপডেট হতে পারে — অ্যাপের ভেতরে জানানো হবে।` :
      `Panda Voice Terms of Service

1. Age: 13+ only.
2. Respect: harassment, hate speech or sexual conduct is prohibited.
3. Content: you are responsible for what you say. Do not share others' copyrighted or private information.
4. Virtual coins: coins are in-app virtual items and are non-refundable except where required by law.
5. Safety: reported accounts may be suspended or banned.
6. Changes: these terms may be updated and announced in the app.`;

    const PRIVACY = isBn() ? `গোপনীয়তা নীতি

• সংগ্রহ: অ্যাকাউন্ট তথ্য (নাম, আইডি, প্রোফাইল ছবি), আপনার অনুমতিতে মাইক্রোফোন।
• অডিও: ভয়েস সরাসরি ব্যবহারকারীদের মধ্যে (P2P) যায় — সার্ভারে কখনোই রেকর্ড বা সংরক্ষণ করা হয় না। আপনার সম্মতি ছাড়া মাইক্রোফোন চালু হয় না।
• ব্যবহার: ডেটা কেবল সেবা চালাতে ব্যবহৃত হয়। কোনো তৃতীয় পক্ষকে বিক্রি করা হয় না।
• মুছে ফেলা: Settings → Delete Account থেকে আপনার সব ডেটা মুছে ফেলতে পারবেন।
• শিশু সুরক্ষা: ১৩ বছরের নিচে ব্যবহার নিষিদ্ধ; অভিভাবকের সম্মতি ছাড়া শিশুদের ডেটা সংরক্ষণ করা হয় না।` :
      `Privacy Policy

• Collected: account info (name, ID, avatar) and your microphone — only with permission.
• Audio: voice travels peer-to-peer; the server never records or stores it. The microphone is never enabled without your consent.
• Use: data is used solely to run the service. It is never sold to third parties.
• Deletion: Settings → Delete Account removes all of your data.
• Children: under-13 use is prohibited; children's data is not stored without verifiable parental consent.`;

    body.append(el('div', { class: 'seg', style: { maxWidth: '280px', margin: '4px 0 14px' } },
      el('button', { class: which === 'terms' ? 'is-active' : '', text: t('terms'), onclick: (e) => { render('terms'); } }),
      el('button', { class: which === 'privacy' ? 'is-active' : '', text: t('privacy'), onclick: () => { render('privacy'); } })));
    const text = el('div', { class: 'list-card', style: { padding: '16px', whiteSpace: 'pre-wrap', lineHeight: 1.8, color: 'var(--text-dim)', fontSize: '13.5px' } });
    function render(w) {
      text.textContent = w === 'terms' ? TERMS : PRIVACY;
      const segEl = body.querySelector('.seg');
      [...segEl.children].forEach((b, i) => b.classList.toggle('is-active', (i === 0) === (w === 'terms')));
    }
    body.append(text);
    render(which);
  });
};
