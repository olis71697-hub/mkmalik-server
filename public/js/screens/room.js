/* Voice Room — 10 mic seats, real WebRTC audio, chat, reactions, gifts,
 * host & moderator controls, themes, connection status. */

import { $, $$, el, toast, svg, ICON, compact, clockLabel, avatarImg, confirmBox, haptic, categoryEmoji } from '../util.js';
import { t, isBn } from '../i18n.js';
import { api, session } from '../api.js';
import { VoiceEngine, loadIceServers } from '../rtc.js';

export { openPage } from './extra.js';

const REACTIONS = ['❤️', '😂', '😍', '🔥', '👏', '👍', '😎', '😭', '🥰', '🎉', '👋', '💯'];

let mounted = false;
let currentRoomId = null;
let snap = null;            // last room snapshot
let engine = null;          // VoiceEngine
let giftCatalog = [];
let pinNeeded = false;

export function roomIsOpen() { return !!currentRoomId; }

export async function openRoom(App, roomId, { pin } = {}) {
  if (currentRoomId === roomId) { $('#room').hidden = false; return; }
  if (currentRoomId) await leaveRoom(App, true);

  try {
    await loadIceServers();
  } catch (_) { /* STUN fallback */ }

  if (!giftCatalog.length) {
    try { giftCatalog = (await api.gifts()).gifts || []; } catch (_) {}
  }

  currentRoomId = roomId;
  mount(App);

  App.socket.emit('room:join', { roomId, pin }, async (res) => {
    if (!res?.ok) {
      if (/password/i.test(res?.error || '')) {
        const code = await promptPin(App, res.error);
        if (code) { currentRoomId = null; return openRoom(App, roomId, { pin: code }); }
        currentRoomId = null;
        $('#room').hidden = true;
        return;
      }
      toast(res?.error || t('error'), 'err');
      currentRoomId = null;
      $('#room').hidden = true;
      return;
    }
    $('#room').hidden = false;
    haptic(10);
    applySnapshot(App, res.room);
    if (engine) engine.syncPeers(res.peers || []);
  });
}

function promptPin(App, msg) {
  return new Promise((resolve) => {
    const inp = el('input', { class: 'input', type: 'text', placeholder: '••••••', style: { marginTop: '10px' } });
    const modal = el('div', { class: 'modal' },
      el('div', { class: 'modal-scrim', onclick: () => { modal.remove(); resolve(null); } }),
      el('div', { class: 'modal-panel' },
        el('h3', { class: 'modal-title', text: t('roomPassword') }),
        el('p', { class: 'modal-body', text: msg }),
        inp,
        el('div', { class: 'modal-actions', style: { marginTop: '14px' } },
          el('button', { class: 'btn btn--ghost', text: t('cancel'), onclick: () => { modal.remove(); resolve(null); } }),
          el('button', { class: 'btn btn--primary', text: t('ok'), onclick: () => { modal.remove(); resolve(inp.value.trim() || null); } }))));
    document.body.append(modal);
    requestAnimationFrame(() => { modal.classList.add('is-open'); inp.focus(); });
  });
}

export async function leaveRoom(App, switching = false) {
  if (!currentRoomId) return;
  try { App.socket.emit('room:leave'); } catch (_) {}
  try { engine?.destroy(); } catch (_) {}
  engine = null;
  currentRoomId = null;
  snap = null;
  if (!switching) $('#room').hidden = true;
}

/* ═══════════════════════════ mount socket handlers once ═══════════════════════════ */
function mount(App) {
  if (mounted) return;
  mounted = true;

  const S = () => App.socket;

  // ---- voice engine ----
  engine = null;
  function ensureEngine() {
    if (engine) return engine;
    engine = new VoiceEngine(S(), {
      onSpeaking: (speaking) => {
        // engine already emits rtc:speaking itself
      },
      onState: (st) => {
        if (st === 'mic-lost') toast(t('micDenied'), 'err');
        if (st === 'autoplay-blocked') {
          toast(isBn() ? 'সাউন্ড চালু করতে স্ক্রিনে একবার ট্যাপ করুন' : 'Tap once to enable sound');
        }
      },
      onLevel: (level) => updateOwnWave(level),
      onRemoteStream: () => {},
    });
    return engine;
  }

  S().on('room:state', (room) => { if (room?.id === currentRoomId) applySnapshot(App, room); });
  S().on('room:seatlock', ({ seat, locked }) => {
    if (locked) lockedSeats.add(seat); else lockedSeats.delete(seat);
    if (snap) renderSeats(App, snap);
  });
  S().on('room:peers', (p) => {
    if (p?.roomId !== currentRoomId || !engine) return;
    engine.syncPeers(p.peers || []);
  });
  S().on('room:message', (msg) => {
    if (!snap) return;
    snap.messages = [...(snap.messages || []), msg].slice(-80);
    appendChatLine(msg);
    scrollChat();
  });
  S().on('room:seat', (p) => {
    // granular update arrives before the state broadcast; just refresh on state
  });
  S().on('room:speaking', ({ userId, speaking }) => {
    const node = $(`.seat[data-user="${userId}"]`);
    if (node) {
      node.classList.toggle('is-speaking', speaking);
      const wave = node.querySelector('.vwave');
      if (wave) wave.style.visibility = speaking ? 'visible' : 'hidden';
    }
  });
  S().on('room:gift', (ev) => {
    showGiftFx(ev);
    App.events.emit('wallet-refresh');
  });
  S().on('room:reaction', (r) => showReactionFx(r));
  S().on('room:closed', (p) => {
    toast(t('roomClosed'), 'err');
    leaveRoom(App);
  });
  S().on('seat:granted', (p) => { toast(t('seatGranted'), 'ok'); });
  S().on('seat:invited', async (p) => {
    if (p.roomId !== currentRoomId) return;
    haptic(20);
    const okBtn = await confirmBox({
      title: `🎤 ${p.byName} ${isBn() ? 'আপনাকে সিট ' + (p.seat + 1) + ' এ আমন্ত্রণ জানিয়েছে' : 'invited you to seat ' + (p.seat + 1)}`,
      okLabel: t('takeSeat'),
    });
    if (okBtn) {
      S().emit('seat:take', { index: p.seat }, (r) => { if (!r?.ok) toast(r?.error, 'err'); });
    }
  });
  S().on('seat:force_muted', (p) => {
    if (p.roomId !== currentRoomId) return;
    if (p.muted) toast('🔇 ' + (isBn() ? 'হোস্ট আপনাকে মিউট করেছে' : 'The host muted you'), 'err');
  });
  S().on('seat:revoked', (p) => { toast('🚫 ' + (isBn() ? 'হোস্ট আপনাকে সিট থেকে সরিয়েছে' : 'Removed from the mic'), 'err'); });

  // reconnect: resume the room after a network blip
  App.events.on('socket', async ({ connected }) => {
    const strip = $('#netStrip');
    if (!connected) {
      if (strip) { strip.className = 'net-strip is-bad'; strip.textContent = '⚠ ' + t('connectionLost'); }
      return;
    }
    if (strip) { strip.className = 'net-strip is-ok'; strip.textContent = '✓ ' + t('connected'); setTimeout(() => { if (strip) strip.textContent = ''; }, 2200); }
    if (currentRoomId) {
      S().emit('room:join', { roomId: currentRoomId }, (res) => {
        if (res?.ok) {
          applySnapshot(App, res.room);
          engine?.syncPeers(res.peers || []);
        } else if (res?.error) {
          toast(res.error, 'err');
          leaveRoom(App);
        }
      });
    }
  });

  // ---- static controls ----
  $('#roomBack').addEventListener('click', () => leaveRoom(App));

  $('#roomInputBar').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#roomInput');
    const body = input.value.trim();
    if (!body) return;
    S().emit('chat:send', { body }, (r) => {
      if (!r?.ok) toast(r?.error, 'err');
    });
    input.value = '';
  });

  $('#roomMore').addEventListener('click', () => openHostMenu(App));
}

/* ═══════════════════════════ snapshot → UI ═══════════════════════════ */
function applySnapshot(App, room) {
  if (!room) return;
  const prevSeats = snap?.seats;
  snap = room;
  myId = App.user?.id || null;

  const roomEl = $('#room');
  roomEl.className = `room theme-${room.theme || 'bamboo'}`;

  // header
  $('#roomHead').innerHTML = '';
  $('#roomHead').append(
    avatarImg(room.members?.find((m) => m.userId === room.ownerId)?.user?.avatar || null, t('host'), 'avatar--sm'),
    el('div', { class: 'room-host-meta' },
      el('span', { class: 'room-host-name' },
        el('span', { text: room.members?.find((m) => m.userId === room.ownerId)?.user?.displayName || t('host') }),
        el('span', { class: 'badge-host', text: t('host') })),
      el('span', { class: 'room-host-id', text: `ID ${room.id.slice(0, 6).toUpperCase()}` })));
  $('#roomBoxText').textContent = room.id.slice(0, 6).toUpperCase();

  // banner
  const banner = $('#roomBanner');
  banner.innerHTML = '';
  banner.append(
    el('div', { class: 'room-title-row' },
      el('span', { class: 'room-live-dot' }),
      el('h2', { text: room.title }),
      room.locked ? el('span', { style: { color: 'var(--gold)' }, html: svg(ICON.lock) }) : null),
    el('p', { class: 'room-topic', text: room.topic || '' }),
    el('div', { class: 'room-stats' },
      el('span', { html: `<b>${room.speakers}</b> 🎙` }),
      el('span', { html: `<b>${room.listeners}</b> 🎧` }),
      el('span', { html: `<b>${compact(room.giftCoins || 0)}</b> 🎁` }),
      el('span', { html: `<b>${room.seatCount}</b> ${isBn() ? 'সিট' : 'seats'}` })));

  renderSeats(App, room, prevSeats);
  renderChat(room);
  renderActions(App, room);
  updateNetStrip();

  // follow mic/seat transitions with the voice engine
  syncEngineWithSeat(App, room);
}

function viewerMember(room) {
  return room.viewer || room.members?.find((m) => m.userId === myId) || null;
}
let myId = null;

/* ---- the 10 seats ---- */
function renderSeats(App, room, prevSeats) {
  const seatsEl = $('#seats');
  seatsEl.innerHTML = '';
  const isMod = !!room.isMod;
  const ownerId = room.ownerId;
  const mods = new Set(room.mods || []);

  room.seats.forEach((member, i) => {
    if (member) {
      const u = member.user || {};
      const seat = el('div', {
        class: 'seat' + (member.isMuted ? ' seat-muted' : '') + (member.handUp ? ' seat-hand' : '') + (member.speaking ? ' is-speaking' : '') + (member.userId === ownerId ? ' seat-host' : ''),
        'data-user': member.userId,
        onclick: () => openSeatSheet(App, room, member, i),
      },
      el('button', { class: 'seat-btn' },
        avatarImg(u.avatar, u.displayName),
        member.isMuted ? el('span', { class: 'muteflag', html: svg(ICON.micOff) }) : null,
      ),
      el('div', { class: 'seat-mods' },
        member.userId === ownerId ? null : mods.has(member.userId) ? el('span', { class: 'badge-mod', text: 'MOD' }) : null),
      el('div', { class: 'seat-badges' },
        u.vip ? el('span', { class: 'vip', html: svg(ICON.crownS) + 'VIP' }) : null,
        el('span', { class: 'lvl' + ((u.level || 1) >= 30 ? ' lvl--gold' : ''), text: u.level || 1 })),
      el('span', { class: 'seat-name', text: u.displayName || ('Seat ' + (i + 1)) }),
      el('div', { class: 'vwave', style: { visibility: 'hidden' } },
        el('i'), el('i'), el('i'), el('i'), el('i')));
      seatsEl.append(seat);
    } else {
      const locked = isSeatLockedVisual(App, room, i);
      const seat = el('div', { class: 'seat seat-empty' + (locked ? ' seat-locked' : ''), 'data-seat': i },
        el('button', {
          class: 'seat-btn',
          html: svg(locked ? ICON.lock : ICON.user),
          onclick: () => {
            if (locked) { toast(t('seatLocked'), 'err'); return; }
            haptic(10);
            App.socket.emit('seat:take', { index: i }, (r) => {
              if (r?.ok) { toast(`${t('seatTaken')} ${i + 1} 🎙️`, 'ok'); }
              else toast(r?.error || t('error'), 'err');
            });
          },
        }),
        el('span', { class: 'seat-name', text: locked ? t('seatLocked') : t('emptySeat') }));
      seatsEl.append(seat);
    }
  });
}

/** host-locked empty seats arrive via room:seatlock; kept in a local set. */
const lockedSeats = new Set();
function isSeatLockedVisual(App, room, i) {
  return lockedSeats.has(i);
}

/* ---- chat ---- */
function renderChat(room) {
  const log = $('#chatLog');
  log.innerHTML = '';
  (room.messages || []).slice(-40).forEach((m) => appendChatLine(m));
  scrollChat();
}

function appendChatLine(m) {
  const log = $('#chatLog');
  if (!log) return;
  let node;
  if (m.kind === 'system') {
    node = el('div', { class: 'chat-line is-system' }, el('span', { text: m.body }), el('span', { class: 'chat-time', text: clockLabel(m.createdAt) }));
  } else if (m.kind === 'gift') {
    node = el('div', { class: 'chat-line is-gift', text: `🎁 ${m.user?.displayName || ''} ${m.body}` });
  } else {
    node = el('div', { class: 'chat-line' },
      m.user ? el('span', { class: 'who', text: m.user.displayName }) : null,
      m.user ? el('span', { class: 'lvl', text: m.user.level || 1 }) : null,
      el('span', { class: 'body', text: m.body }),
      el('span', { class: 'chat-time', text: clockLabel(m.createdAt) }));
  }
  log.append(node);
}

function scrollChat() {
  const log = $('#chatLog');
  if (log) log.scrollTop = log.scrollHeight;
}

/* ---- action bar ---- */
function renderActions(App, room) {
  const bar = $('#roomActions');
  bar.innerHTML = '';
  const me = room.viewer;
  const seated = me && me.seat !== null && me.seat !== undefined;
  const muted = me ? me.isMuted : true;
  const handUp = me ? me.handUp : false;

  // mic button
  const micBtn = el('button', {
    class: 'mic-btn' + (seated && !muted ? ' is-live' : '') + (seated && muted ? ' is-off' : ''),
    html: svg(seated && !muted ? ICON.mic : ICON.micOff) + `<span class="mic-label-abs">${seated ? (muted ? t('unmute') : t('mute')) : t('takeSeat')}</span>`,
    onclick: async () => {
      haptic(12);
      if (!seated) {
        // try to take a free seat
        const free = (snap.seats || []).findIndex((s) => !s);
        if (free === -1) { toast(isBn() ? 'সবগুলো সিট পূর্ণ — হাত তুলুন' : 'All seats taken — raise your hand', 'err'); return; }
        App.socket.emit('seat:take', { index: free }, (r) => {
          if (r?.ok) toast(`${t('seatTaken')} ${free + 1} 🎙️`, 'ok');
          else toast(r?.error || t('error'), 'err');
        });
        return;
      }
      // toggle own mute — needs the microphone
      if (muted) {
        try {
          const eng = ensureEngine();
          await eng.ensureMic();
        } catch (err) {
          toast(micErrorText(err), 'err');
          return;
        }
      }
      App.socket.emit('seat:mute', { muted: !muted }, (r) => { if (!r?.ok) toast(r?.error, 'err'); });
    },
  });

  const act = (icon, label, fn, cls = '') => el('button', { class: 'act-btn ' + cls, html: svg(icon) + `<span>${label}</span>`, onclick: fn });

  bar.append(
    micBtn,
    act(ICON.hand, handUp ? t('lowerHand') : t('raiseHand'), () => {
      App.socket.emit('hand:raise', { up: !handUp }, (r) => { if (r?.ok) toast(r.up ? t('handRaised') + ' ✋' : '', 'ok'); });
    }, handUp ? 'is-gold' : ''),
    act(ICON.heart, t('reactions'), () => toggleReactions(App)),
    act(ICON.gift, t('gifts'), () => openGiftSheet(App), 'is-gold'),
    act(ICON.comment, 'Chat', () => {
      const ib = $('#roomInputBar');
      ib.hidden = !ib.hidden;
      if (!ib.hidden) $('#roomInput').focus();
    }),
    act(engine?.speakerOn === false ? ICON.volumeOff : ICON.volume, t('speaker'), () => {
      const on = !(engine?.speakerOn !== false);
      engine?.setSpeakerEnabled(!on);
      engine?.unlockAudio?.();
      toast(!on ? '🔊 ' + t('speaker') + ' ON' : '🔇 ' + t('speaker') + ' OFF');
      renderActions(App, snap);
    }),
    act(ICON.users, t('members'), () => openMembersSheet(App)),
    act(ICON.share, '', () => shareRoom(App)),
  );
}

function micErrorText(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return t('micDenied');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return isBn() ? 'মাইক্রোফোন পাওয়া যায়নি' : 'No microphone found';
  if (!navigator.mediaDevices?.getUserMedia) return t('micUnsupported');
  return err?.message || t('micPermission');
}

/* ---- engine sync on seat changes ---- */
function syncEngineWithSeat(App, room) {
  const me = room.viewer;
  const seated = me && me.seat !== null && me.seat !== undefined;
  if (!engine) {
    if (!seated) return; // listener with no engine yet is fine
    ensureEngine();
  }
  if (seated && !engine.isSpeaker) {
    engine.goLive().catch((err) => toast(micErrorText(err), 'err'));
  } else if (!seated && engine.isSpeaker) {
    engine.goListener();
  }
  engine.setMuted(me ? me.isMuted : true);
}

function updateOwnWave(level) {
  const me = snap?.viewer;
  if (!me || me.seat === null) return;
  const wave = $(`.seat[data-user="${me.userId}"] .vwave`);
  if (!wave) return;
  wave.style.visibility = level > 0.12 ? 'visible' : 'hidden';
  [...wave.children].forEach((bar, i) => {
    bar.style.height = Math.max(3, Math.min(12, level * 26 * (0.6 + Math.random() * 0.7))) + 'px';
  });
}

function updateNetStrip() {
  const strip = $('#netStrip');
  if (!strip) return;
  if (_socketConnected === false) { strip.className = 'net-strip is-bad'; strip.textContent = '⚠ ' + t('connectionLost'); }
  else { strip.className = 'net-strip'; strip.textContent = ''; }
}
let _socketConnected = null;
export function setSocketConnected(v) { _socketConnected = v; updateNetStrip(); }

/* ═══════════════════════════ reactions ═══════════════════════════ */
let reactionOpen = false;
function toggleReactions(App) {
  const bar = $('#reactionBar');
  if (reactionOpen) { bar.hidden = true; reactionOpen = false; return; }
  bar.innerHTML = '';
  REACTIONS.forEach((emoji) => {
    bar.append(el('button', {
      text: emoji,
      onclick: () => {
        haptic(8);
        App.socket.emit('reaction:send', { emoji }, (r) => {
          if (!r?.ok) toast(r?.error || (isBn() ? 'একটু ধীরে! 🐼' : 'Too fast!'), 'err');
        });
      },
    }));
  });
  bar.hidden = false;
  reactionOpen = true;
  setTimeout(() => { if (reactionOpen) { bar.hidden = true; reactionOpen = false; } }, 6000);
}

function showReactionFx({ userId, displayName, emoji }) {
  const layer = $('#fxLayer');
  if (!layer) return;
  const fx = el('div', { class: 'fx-reaction', text: emoji }, el('b', { text: displayName }));
  fx.style.left = (12 + Math.random() * 68) + '%';
  fx.style.bottom = (16 + Math.random() * 18) + '%';
  layer.append(fx);
  setTimeout(() => fx.remove(), 2700);
}

/* ═══════════════════════════ gift sheet ═══════════════════════════ */
export function openGiftSheet(App, presetRecipientId = null) {
  if (!snap) return;
  const panel = $('#giftPanel');
  panel.innerHTML = '';
  const sheet = $('#giftSheet');
  sheet.hidden = false;

  // seated members are the gift targets
  const targets = (snap.members || []).filter((m) => m.userId !== _viewerId);
  let selectedGift = giftCatalog[0];
  let qty = 1;
  let recipientId = presetRecipientId || (targets[0]?.userId ?? null);
  if (!targets.length) { toast(isBn() ? 'রুমে আর কেউ নেই' : 'Nobody else is here', 'err'); sheet.hidden = true; return; }

  const balanceEl = el('div', { class: 'coin-pill', style: { alignSelf: 'center' } });
  const renderBalance = () => { balanceEl.innerHTML = svg(ICON.coin) + ` ${compact(App.wallet.coins)}`; };
  renderBalance();

  const giftsGrid = el('div', { class: 'gift-grid' });
  function renderGifts() {
    giftsGrid.innerHTML = '';
    giftCatalog.forEach((g) => {
      giftsGrid.append(el('button', {
        class: 'gift-item' + (selectedGift?.id === g.id ? ' is-selected' : ''),
        onclick: () => { selectedGift = g; haptic(6); renderGifts(); renderTotal(); },
      },
        el('span', { class: 'gi-emoji', text: g.emoji }),
        el('span', { class: 'gi-name', text: isBn() && g.id === 'heart' ? 'হার্ট' : g.name }),
        el('span', { class: 'gi-price', html: svg(ICON.coin) + ` ${compact(g.price)}` })));
    });
  }

  const recipientsRow = el('div', { class: 'hlist', style: { padding: '4px 0 10px' } });
  function renderRecipients() {
    recipientsRow.innerHTML = '';
    targets.forEach((m) => {
      recipientsRow.append(el('div', {
        class: 'hcard' + (recipientId === m.userId ? '' : ''),
        style: { opacity: recipientId === m.userId ? 1 : 0.55, outline: recipientId === m.userId ? '2px solid var(--brand)' : 'none', borderRadius: '14px', padding: '4px' },
        onclick: () => { recipientId = m.userId; renderRecipients(); },
      },
        avatarImg(m.user?.avatar, m.user?.displayName, 'avatar--lg'),
        el('div', { class: 'nm', text: m.user?.displayName || '' })));
    });
  }

  const totalEl = el('div', { class: 'coin-pill', style: { alignSelf: 'center', fontSize: '15px' } });
  function renderTotal() {
    const cost = (selectedGift?.price || 0) * qty;
    totalEl.innerHTML = svg(ICON.coin) + ` ${compact(cost)}`;
    totalEl.style.color = cost > App.wallet.coins ? 'var(--danger)' : 'var(--gold)';
  }

  const sendBtn = el('button', { class: 'btn btn--gold btn--block', text: t('sendGift') });
  sendBtn.onclick = () => {
    const cost = (selectedGift?.price || 0) * qty;
    if (cost > App.wallet.coins) {
      confirmBox({ title: t('notEnoughCoins'), body: t('needMore', { n: cost - App.wallet.coins }), okLabel: t('goToWallet') })
        .then((yes) => { if (yes) { sheet.hidden = true; import('../app.js').then(({ go }) => go('wallet')); } });
      return;
    }
    sendBtn.disabled = true;
    App.socket.emit('gift:send', { toUserId: recipientId, giftId: selectedGift.id, qty }, (r) => {
      sendBtn.disabled = false;
      if (r?.ok) {
        App.setWallet({ coins: r.coins });
        toast(`${t('giftSent')} ${selectedGift.emoji} ×${qty}`, 'ok');
        sheet.hidden = true;
      } else {
        if (r?.code === 'insufficient_coins') {
          confirmBox({ title: t('notEnoughCoins'), body: r.error, okLabel: t('goToWallet') })
            .then((yes) => { if (yes) { sheet.hidden = true; import('../app.js').then(({ go }) => go('wallet')); } });
        } else toast(r?.error || t('error'), 'err');
      }
    });
  };

  panel.append(
    el('div', { class: 'sheet-grip' }),
    el('div', { class: 'sheet-title' }, el('span', { text: '🎁 ' + t('gifts') }), balanceEl),
    el('div', { class: 'sheet-title', style: { fontSize: '13px', color: 'var(--text-dim)', fontWeight: 600 }, text: t('selectRecipient') }),
    recipientsRow,
    giftsGrid,
    el('div', { class: 'gift-qty' },
      el('button', { text: '−', onclick: () => { qty = Math.max(1, qty - 1); qtyEl.textContent = qty; renderTotal(); } }),
      (() => { qtyEl = el('b', { text: '1' }); return qtyEl; })(),
      el('button', { text: '+', onclick: () => { qty = Math.min(99, qty + 1); qtyEl.textContent = qty; renderTotal(); } })),
    totalEl,
    el('div', { class: 'center-note', text: t('giftCoinHint'), style: { fontSize: '10.5px' } }),
    sendBtn,
  );

  let qtyEl;
  renderGifts();
  renderRecipients();
  renderTotal();
}
let qtyEl = null;

function showGiftFx(ev) {
  const layer = $('#fxLayer');
  if (!layer) return;
  const fx = el('div', { class: 'fx-gift' },
    el('div', { class: 'big', text: ev.gift?.emoji || '🎁' }),
    ev.qty > 1 ? el('div', { class: 'qty', text: `×${ev.qty}` }) : null,
    el('div', { class: 'who', text: `${ev.from?.displayName || ''} → ${ev.to?.user?.displayName || ev.to?.displayName || ''}` }));
  layer.append(fx);
  setTimeout(() => fx.remove(), 2900);
  haptic(30);
}

/* ═══════════════════════════ seat sheet (occupied seat) ═══════════════════════════ */
function openSeatSheet(App, room, member, seatIndex) {
  const panel = $('#sheetPanel');
  panel.innerHTML = '';
  $('#sheet').hidden = false;
  const u = member.user || {};
  const isMe = member.userId === _viewerId;
  const isMod = !!room.isMod;
  const isOwner = room.ownerId === _viewerId;

  const row = (icon, label, sub, fn, danger = false) => el('button', { class: 'list-row' + (danger ? ' is-danger' : ''), onclick: fn },
    el('span', { class: 'li-icon' + (danger ? ' is-danger' : ''), html: svg(icon) }),
    el('span', { class: 'li-body' }, el('span', { class: 'li-t', text: label }), sub ? el('span', { class: 'li-s', text: sub }) : null),
    el('span', { class: 'li-end', html: svg(ICON.chev) }));

  panel.append(
    el('div', { class: 'sheet-grip' }),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } },
      avatarImg(u.avatar, u.displayName, 'avatar--lg'),
      el('div', {},
        el('div', { style: { fontWeight: 800, fontSize: '16px', display: 'flex', gap: '6px', alignItems: 'center' } },
          el('span', { text: u.displayName }),
          u.vip ? el('span', { class: 'vip', html: svg(ICON.crownS) + 'VIP' }) : null,
          el('span', { class: 'lvl', text: u.level || 1 })),
        el('div', { style: { color: 'var(--text-faint)', fontSize: '12px' } }, `ID ${u.userCode || '—'} · ${isBn() ? 'সিট' : 'Seat'} ${seatIndex + 1}`))),
  );

  const close = () => { $('#sheet').hidden = true; };

  if (!isMe) {
    panel.append(row(ICON.user, t('profile'), '', () => { close(); import('./extra.js').then(({ openPage }) => openPage.userProfile(App, member.userId)); }));
    panel.append(row(ICON.comment, t('message'), '', () => { close(); import('./extra.js').then(({ openPage }) => openPage.chatThread(App, member.userId, u)); }));
    panel.append(row(ICON.gift, t('sendGift'), `${selectedGiftPriceHint()}`, () => { close(); openGiftSheet(App, member.userId); }, false));
  } else {
    panel.append(row(member.isMuted ? ICON.mic : ICON.micOff, member.isMuted ? t('unmute') : t('mute'), '', async () => {
      close();
      if (member.isMuted) {
        try { await ensureEngine().ensureMic(); } catch (err) { toast(micErrorText(err), 'err'); return; }
      }
      App.socket.emit('seat:mute', { muted: !member.isMuted }, (r) => { if (!r?.ok) toast(r?.error, 'err'); });
    }));
    panel.append(row(ICON.close, t('leaveSeat'), '', () => {
      close();
      App.socket.emit('seat:leave', {}, (r) => { if (!r?.ok) toast(r?.error, 'err'); });
    }));
  }

  if (isMod && !isMe && member.userId !== room.ownerId) {
    panel.append(el('div', { class: 'section-head' }, el('h2', { text: '🛡 ' + (isOwner ? t('host') : t('moderator')) })));
    if (member.seat === null) {
      panel.append(row(ICON.mic, t('inviteToSeat'), '', () => {
        close();
        App.socket.emit('seat:invite', { userId: member.userId }, (r) => {
          if (r?.ok) toast(isBn() ? 'আমন্ত্রণ পাঠানো হয়েছে ✉️' : 'Invitation sent ✉️', 'ok');
          else toast(r?.error || t('error'), 'err');
        });
      }));
    }
    if (member.seat !== null) {
      panel.append(row(member.isMuted ? ICON.mic : ICON.micOff,
        member.isMuted ? t('unmute') : t('mute') + ' (' + (isBn() ? 'জোর করে' : 'force') + ')', '',
        () => { close(); App.socket.emit('seat:mute_other', { userId: member.userId, muted: !member.isMuted }, (r) => { if (!r?.ok) toast(r?.error, 'err'); }); }));
    }
    if (isOwner) {
      panel.append(row(ICON.shield, room.mods?.includes(member.userId) ? t('removeMod') : t('makeMod'), '', () => {
        close();
        App.socket.emit('mod:set', { userId: member.userId, isMod: !room.mods?.includes(member.userId) }, (r) => { if (!r?.ok) toast(r?.error, 'err'); });
      }));
    }
    if (member.seat !== null) {
      panel.append(row(ICON.close, t('removeFromSeat'), '', () => {
        close();
        App.socket.emit('seat:kick', { userId: member.userId }, (r) => { if (!r?.ok) toast(r?.error, 'err'); });
      }, true));
    }
    panel.append(row(ICON.ban, t('ban'), '', () => {
      close();
      confirmBox({ title: t('ban') + '?', body: u.displayName, okLabel: t('ban'), danger: true }).then((yes) => {
        if (yes) App.socket.emit('room:ban', { userId: member.userId }, (r) => { if (!r?.ok) toast(r?.error, 'err'); });
      });
    }, true));
  }

  if (!isMe) {
    panel.append(el('div', { class: 'section-head' }, el('h2', { text: '⚙' })));
    panel.append(row(ICON.ban, t('report'), '', () => { close(); import('./extra.js').then(({ openPage }) => openPage.report(App, 'user', member.userId, u.displayName)); }, true));
  }
}

function selectedGiftPriceHint() { return giftCatalog.length ? `${giftCatalog[0].emoji} ${compact(giftCatalog[0].price)}+` : ''; }

/* ═══════════════════════════ members sheet ═══════════════════════════ */
function openMembersSheet(App) {
  if (!snap) return;
  const panel = $('#sheetPanel');
  panel.innerHTML = '';
  $('#sheet').hidden = false;
  const close = () => { $('#sheet').hidden = true; };

  const speakers = (snap.members || []).filter((m) => m.seat !== null);
  const listeners = (snap.members || []).filter((m) => m.seat === null);

  const mk = (m) => el('div', { class: 'user-row', onclick: () => { close(); openSeatSheet(App, snap, m, m.seat ?? -1); } },
    avatarImg(m.user?.avatar, m.user?.displayName, 'avatar--sm'),
    el('div', { class: 'meta' },
      el('div', { class: 'name' },
        el('span', { text: m.user?.displayName || '—' }),
        m.userId === snap.ownerId ? el('span', { class: 'badge-host', text: t('host') }) : null,
        snap.mods?.includes(m.userId) ? el('span', { class: 'badge-mod', text: 'MOD' }) : null,
        el('span', { class: 'lvl', text: m.user?.level || 1 })),
      el('div', { class: 'sub' },
        el('span', { class: 'on-dot' + (m.speaking ? '' : ' is-off') }),
        el('span', { text: `${m.isMuted ? '🔇 ' : '🎙 '}${m.seat !== null ? (isBn() ? 'সিট' : 'Seat') + ' ' + (m.seat + 1) : '🎧 ' + t('listeners')}${m.handUp ? ' · ✋' : ''}` }))));

  panel.append(
    el('div', { class: 'sheet-grip' }),
    el('div', { class: 'sheet-title' }, el('span', { text: '👥 ' + t('members') }), el('span', { class: 'sub', text: String(snap.members?.length || 0) })),
  );
  if (speakers.length) {
    panel.append(el('div', { class: 'section-head', style: { marginTop: '0' } }, el('h2', { text: '🎙 ' + (isBn() ? 'কথা বলছেন' : 'On mic') })));
    speakers.forEach((m) => panel.append(mk(m)));
  }
  if (listeners.length) {
    panel.append(el('div', { class: 'section-head' }, el('h2', { text: '🎧 ' + t('listeners') }), el('span', { class: 'count', text: String(listeners.length) })));
    listeners.forEach((m) => panel.append(mk(m)));
  }
  if (!snap.members?.length) panel.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '🐼' })));
}

/* ═══════════════════════════ host menu ═══════════════════════════ */
function openHostMenu(App) {
  if (!snap) return;
  const panel = $('#sheetPanel');
  panel.innerHTML = '';
  $('#sheet').hidden = false;
  const close = () => { $('#sheet').hidden = true; };
  const row = (icon, label, sub, fn, danger = false) => el('button', { class: 'list-row' + (danger ? ' is-danger' : ''), onclick: fn },
    el('span', { class: 'li-icon' + (danger ? ' is-danger' : ''), html: svg(icon) }),
    el('span', { class: 'li-body' }, el('span', { class: 'li-t', text: label }), sub ? el('span', { class: 'li-s', text: sub }) : null),
    el('span', { class: 'li-end', html: svg(ICON.chev) }));

  const isMod = !!snap.isMod;
  const isOwner = snap.ownerId === _viewerId;

  panel.append(
    el('div', { class: 'sheet-grip' }),
    el('div', { class: 'sheet-title' }, el('span', { text: '⚙ ' + (isBn() ? 'রুম অপশন' : 'Room options') })),
  );

  // theme picker
  const themes = ['bamboo', 'gold', 'rose', 'ocean', 'violet', 'mint', 'sunset', 'night'];
  const themeRow = el('div', { class: 'hlist', style: { padding: '6px 0 10px' } });
  themes.forEach((th) => {
    themeRow.append(el('button', {
      class: 'chip' + (snap.theme === th ? ' is-active' : ''),
      style: { background: `linear-gradient(135deg, var(--room-a, #34d399), var(--surface-2))` },
      text: th,
      onclick: () => {
        if (!isMod) { toast(isBn() ? 'শুধু হোস্ট থিম বদলাতে পারে' : 'Only the host can change the theme', 'err'); return; }
        App.socket.emit('room:update', { theme: th }, (r) => { if (r?.ok) { close(); toast(t('theme') + ' ✓'); } else toast(r?.error, 'err'); });
      },
    }));
  });
  panel.append(el('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--text-dim)', padding: '4px 2px' }, text: '🎨 ' + t('theme') }), themeRow);

  if (isMod) {
    panel.append(row(ICON.edit, t('editRoom'), snap.title, () => { close(); openEditRoom(App); }));
    panel.append(row(ICON.comment, snap.chatOpen === false ? (isBn() ? 'চ্যাট চালু করুন' : 'Enable chat') : (isBn() ? 'চ্যাট বন্ধ করুন' : 'Disable chat'), '', () => {
      close();
      App.socket.emit('room:update', { chatOpen: snap.chatOpen === false }, (r) => { if (!r?.ok) toast(r?.error, 'err'); });
    }));
    panel.append(row(ICON.shield, t('modLog'), '', async () => {
      close();
      App.socket.emit('room:modlog', {}, (r) => {
        if (r?.ok) openModLog(r.log || []);
        else toast(r?.error, 'err');
      });
    }));
    panel.append(row(ICON.lock, snap.locked ? (isBn() ? 'রুম আনলক' : 'Unlock room') : (isBn() ? 'রুম লক' : 'Lock room'), '', () => {
      close();
      App.socket.emit('room:update', { locked: !snap.locked }, (r) => { if (!r?.ok) toast(r?.error, 'err'); });
    }));
    // seat locks
    panel.append(row(ICON.lock, isBn() ? 'সিট লক/আনলক' : 'Seat locks', '', () => { close(); openSeatLocks(App); }));
  }

  panel.append(row(ICON.info, t('rules'), '', () => { close(); showRules(App); }));
  panel.append(row(ICON.share, isBn() ? 'শেয়ার' : 'Share', '', () => { close(); shareRoom(App); }));
  panel.append(row(ICON.ban, t('report'), '', () => { close(); import('./extra.js').then(({ openPage }) => openPage.report(App, 'room', snap.id, snap.title)); }, true));

  if (isOwner) {
    panel.append(row(ICON.close, t('endRoom'), '', () => {
      close();
      confirmBox({ title: t('endRoom') + '?', body: isBn() ? 'সবাই রুম থেকে বেরিয়ে যাবে' : 'Everyone will be removed', okLabel: t('endRoom'), danger: true }).then((yes) => {
        if (yes) App.socket.emit('room:end', {}, (r) => { if (r?.ok) leaveRoom(App); else toast(r?.error, 'err'); });
      });
    }, true));
  }
  panel.append(row(ICON.logout, t('leaveRoom'), '', () => { close(); leaveRoom(App); }));
}

function openSeatLocks(App) {
  const panel = $('#sheetPanel');
  panel.innerHTML = '';
  $('#sheet').hidden = false;
  const close = () => { $('#sheet').hidden = true; };

  const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '10px', padding: '6px 0' } });
  function render() {
    grid.innerHTML = '';
    (snap.seats || []).forEach((m, i) => {
      const locked = lockedSeats.has(i);
      grid.append(el('button', {
        class: 'btn btn--sm ' + (locked ? 'btn--gold' : m ? 'btn--ghost' : 'btn--primary'),
        text: `${i + 1}\n${locked ? '🔒' : m ? '👤' : '＋'}`,
        style: { flexDirection: 'column', height: '54px', whiteSpace: 'pre', lineHeight: 1.2 },
        onclick: () => {
          App.socket.emit('seat:lock', { index: i, locked: !locked }, (r) => {
            if (r?.ok) { lockedSeats.delete(i); if (locked === false) lockedSeats.add(i); render(); }
            else toast(r?.error, 'err');
          });
        },
      }));
    });
  }
  render();
  panel.append(
    el('div', { class: 'sheet-grip' }),
    el('div', { class: 'sheet-title' }, el('span', { text: '🔒 ' + (isBn() ? 'সিট লক' : 'Seat locks') }),
      el('span', { class: 'sub', text: isBn() ? 'খালি সিট লক করুন' : 'lock empty seats' })),
    grid,
    el('div', { class: 'center-note', text: isBn() ? '🔒 = লক করা · 👤 = কেউ বসে আছে · ＋ = খোলা' : '🔒 locked · 👤 occupied · ＋ open' }),
  );
}

function openModLog(log) {
  const panel = $('#sheetPanel');
  panel.innerHTML = '';
  $('#sheet').hidden = false;
  panel.append(
    el('div', { class: 'sheet-grip' }),
    el('div', { class: 'sheet-title' }, el('span', { text: '🛡 ' + t('modLog') })),
  );
  if (!log.length) panel.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '📭' }), el('p', { text: t('empty') })));
  log.forEach((l) => {
    panel.append(el('div', { class: 'notif-row' },
      el('div', { class: 'n-icon', text: { kick: '🚫', ban: '⛔', mute: '🔇', mod_add: '🛡', mod_remove: '🛡', lock: '🔒', unlock: '🔓' }[l.action] || '•' }),
      el('div', { class: 'n-body' },
        el('div', { class: 'n-t', text: `${l.actor} → ${l.action}${l.target ? ' → ' + l.target : ''}` }),
        el('div', { class: 'n-b', text: l.note || '' })),
      el('span', { class: 'n-time', text: clockLabel(l.createdAt) })));
  });
}

function showRules(App) {
  const panel = $('#sheetPanel');
  panel.innerHTML = '';
  $('#sheet').hidden = false;
  panel.append(
    el('div', { class: 'sheet-grip' }),
    el('div', { class: 'sheet-title' }, el('span', { text: '📋 ' + t('rules') })),
    el('p', { style: { color: 'var(--text-dim)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }, text: snap?.rules || (isBn() ? 'রুমের কোনো নিয়ম নেই' : 'No rules set') }),
  );
}

function openEditRoom(App) {
  const panel = $('#sheetPanel');
  panel.innerHTML = '';
  $('#sheet').hidden = false;
  const close = () => { $('#sheet').hidden = true; };

  const title = el('input', { class: 'input', value: snap?.title || '', maxlength: '60', style: { paddingLeft: '14px' } });
  const topic = el('input', { class: 'input', value: snap?.topic || '', maxlength: '120', style: { paddingLeft: '14px' } });
  const rules = el('textarea', { class: 'input', maxlength: '300' });
  rules.value = snap?.rules || '';
  const save = el('button', { class: 'btn btn--primary btn--block', text: t('save') });
  save.onclick = () => {
    App.socket.emit('room:update', { title: title.value.trim(), topic: topic.value.trim(), rules: rules.value.trim() }, (r) => {
      if (r?.ok) { toast(t('saved'), 'ok'); close(); } else toast(r?.error, 'err');
    });
  };

  panel.append(
    el('div', { class: 'sheet-grip' }),
    el('div', { class: 'sheet-title' }, el('span', { text: '✏️ ' + t('editRoom') })),
    el('div', { class: 'field' }, el('label', { text: t('roomName') }), title),
    el('div', { class: 'field' }, el('label', { text: t('roomTopic') }), topic),
    el('div', { class: 'field' }, el('label', { text: t('roomRules') }), rules),
    save,
  );
}

async function shareRoom(App) {
  const url = location.origin + location.pathname + '?room=' + (snap?.id || '');
  const data = { title: `Panda Voice — ${snap?.title || ''}`, text: isBn() ? 'এসো ভয়েস রুমে 🐼🎙️' : 'Join this voice room 🐼🎙️', url };
  try {
    if (navigator.share) await navigator.share(data);
    else { await navigator.clipboard.writeText(url); toast(t('copied') + ' ✓', 'ok'); }
  } catch (_) {}
}
