/* ---------------------------------------------------------------------------
   Live room — 10 mic seats, real WebRTC audio, chat, gifts, host controls.
   --------------------------------------------------------------------------- */

import {
  $, el, toast, svg, ICON, compact, coverFor, shortId, categoryLabel,
  haptic, CATEGORIES,
} from '../util.js';
import { api } from '../api.js';
import { VoiceEngine, RemoteLevels, loadIceServers } from '../rtc.js';

export function mountRoom(App) {
  const root      = $('#room');
  const seatsWrap = $('#seats');
  const slotsWrap = $('#roomSlots');
  const chatLog   = $('#chatLog');
  const roomScroll= $('#roomScroll');
  const micBtn    = $('#micBtn');
  const micLabel  = $('#micLabel');
  const handBtn   = $('#handBtn');
  const inputBar  = $('#roomInputBar');
  const input     = $('#roomInput');
  const statsWrap = $('#roomStats');

  let room = null;             // latest snapshot from the server
  let voice = null;            // VoiceEngine
  let levels = null;           // RemoteLevels
  let pin = null;              // PIN supplied when joining a private room
  let leaving = false;
  let seatsDirty = false;

  const mySeat = () => (room?.members || []).find((m) => m.userId === App.user?.id)?.seat ?? null;
  const amSpeaker = () => mySeat() !== null;
  const isHost = () => room && (room.isOwner || App.user?.role === 'admin');

  // ── open / close ─────────────────────────────────────────────────────────
  App.events.on('room:open', async ({ roomId, autoSeat, pin: joinPin }) => {
    pin = joinPin || null;
    const socket = App.socket;
    if (!socket?.connected) return toast('Not connected — retry in a second', 'err');

    root.hidden = false;
    room = null;
    seatsWrap.innerHTML = '';
    chatLog.innerHTML = '';
    inputBar.hidden = true;
    $('#roomTitle').textContent = 'Connecting…';
    $('#roomTopic').textContent = '';

    await joinRoom(roomId, autoSeat);
  });

  App.events.on('room:leave-request', () => leaveRoom('left'));

  async function joinRoom(roomId, autoSeat) {
    const socket = App.socket;

    const res = await new Promise((resolve) => {
      socket.emit('room:join', { roomId, seat: autoSeat ? true : undefined, pin }, resolve);
      setTimeout(() => resolve({ ok: false, error: 'Join timed out' }), 8000);
    });

    if (!res || !res.ok) {
      toast(res?.error || 'Could not join the room', 'err');
      root.hidden = true;
      return;
    }

    room = res.room;
    leaving = false;
    renderRoom();
    renderSeats();
    renderChat(true);
    startVoice(res.peers || []);
    App.events.emit('room:joined', room);

    if (res.room.viewer && res.room.viewer.seat !== null) {
      micBtn.classList.add('is-live');
      micBtn.classList.toggle('is-muted', res.room.viewer.isMuted);
      micLabel.textContent = res.room.viewer.isMuted ? 'Tap to unmute' : 'On mic';
    }
  }

  async function leaveRoom(reason) {
    if (leaving) return;
    leaving = true;
    try { App.socket?.emit('room:leave', { reason }); } catch (_) {}
    teardownVoice();
    root.hidden = true;
    room = null;
    App.events.emit('room:left');
    App.events.emit('rooms:refresh');
  }

  function teardownVoice() {
    try { voice?.destroy(); } catch (_) {}
    try { levels?.destroy(); } catch (_) {}
    voice = null;
    levels = null;
    micBtn.classList.remove('is-live', 'is-muted');
    micLabel.textContent = 'Join mic';
    handBtn.classList.remove('is-on');
  }

  // ── voice ────────────────────────────────────────────────────────────────
  function startVoice(peers) {
    teardownVoice();
    levels = new RemoteLevels();
    levels.onUpdate = (map) => {
      for (const [peerId, lvl] of map) {
        const node = seatsWrap.querySelector(`.seat[data-user="${peerId}"]`);
        if (node) node.classList.toggle('is-speaking', lvl > 0.2 && node.dataset.muted !== '1');
      }
    };

    voice = new VoiceEngine(App.socket, {
      onSpeaking: (speaking) => {
        const mine = seatsWrap.querySelector(`.seat[data-user="${App.user.id}"]`);
        if (mine) mine.classList.toggle('is-speaking', speaking);
      },
      onLevel: (lvl) => {
        const node = seatsWrap.querySelector(`.seat[data-user="${App.user.id}"]`);
        if (node && lvl > 0.02) node.style.setProperty('--lvl', lvl.toFixed(2));
      },
      onState: (evt) => {
        if (evt === 'autoplay-blocked') toast('Tap anywhere to enable room audio');
        if (evt === 'mic-lost') toast('Microphone disconnected', 'err');
      },
      onRemoteStream: (peerId, stream) => levels?.attach(peerId, stream),
    });

    // ICE config (including any TURN relay) must be in place before we build
    // peer connections, so the first sync waits for it. The engine already
    // exists, so a room:peers push arriving meanwhile is not lost.
    const engine = voice;
    loadIceServers()
      .then(() => engine.syncPeers(peers))
      .catch((e) => console.warn('[room] peer sync', e.message));
  }

  function applyPeers(res) {
    if (!voice) return;
    const peers = res.peers || res.room?.peers || [];
    voice.syncPeers(peers).catch(() => {});
  }

  // ── rendering: room header ───────────────────────────────────────────────
  function renderRoom() {
    if (!room) return;
    const host = room.members.find((m) => m.userId === room.ownerId)?.user || room.host;

    $('#roomTitle').textContent = room.title;
    $('#roomTopic').textContent = room.topic || '';
    $('#roomBoxText').textContent = shortId(room.id);
    $('#roomHostAvatar').src = host?.avatar || '';
    $('#roomHostName').textContent = host?.displayName || 'Host';
    $('#roomHostId').textContent = 'ID ' + shortId(room.ownerId);

    statsWrap.innerHTML = '';
    statsWrap.append(
      el('div', { class: 'pill-stat' },
        el('span', { html: svg(ICON.user, { width: 12, height: 12 }) }),
        el('span', { text: compact(room.members.length) + ' in room' }),
      ),
      el('div', { class: 'pill-stat' },
        el('span', { html: svg(ICON.mic, { width: 12, height: 12 }) }),
        el('span', { text: `${room.speakers}/10 on mic` }),
      ),
      el('div', { class: 'pill-stat is-accent' },
        el('span', { html: svg(ICON.diamond, { width: 12, height: 12 }) }),
        el('span', { text: compact(room.giftCoins) }),
      ),
    );
  }

  // ── rendering: 10 mic seats ──────────────────────────────────────────────
  function renderSeats() {
    if (!room) return;
    seatsWrap.innerHTML = '';

    for (let i = 0; i < 10; i++) {
      const member = room.seats[i];
      seatsWrap.append(seatEl(i, member));
    }

    // listener / free-seat line, with a live equaliser when someone speaks
    const free = 10 - room.speakers;
    const speaking = room.members.some((m) => m.speaking);
    slotsWrap.className = 'room-empty-slots' + (speaking ? ' is-live' : '');
    slotsWrap.innerHTML = '';
    slotsWrap.append(
      el('span', { class: 'bars', html: '<i></i><i></i><i></i><i></i><i></i>' }),
      el('span', {
        text: free > 0
          ? `${free} mic seat${free === 1 ? '' : 's'} free · ${room.listeners} listening`
          : `${room.listeners} listening · all mics full`,
      }),
    );

    // my own controls
    const seated = amSpeaker();
    const mine = room.members.find((m) => m.userId === App.user.id);
    micBtn.classList.toggle('is-live', seated);
    micBtn.classList.toggle('is-muted', seated && mine?.isMuted);
    micLabel.textContent = !seated ? 'Join mic' : (mine?.isMuted ? 'Tap to unmute' : 'On mic');
    handBtn.classList.toggle('is-on', !!mine?.handUp);
  }

  function seatEl(index, member) {
    const node = el('div', { class: 'seat', 'data-seat': index });

    if (!member) {
      node.append(
        el('div', { class: 'seat-ring' }, el('div', { class: 'seat-ph', text: '+' })),
        el('div', { class: 'seat-name', text: `Seat ${index + 1}` }),
      );
      node.addEventListener('click', () => onSeatTap(index, null));
      return node;
    }

    const isMe = member.userId === App.user?.id;
    const u = member.user || {};
    node.dataset.user = member.userId;
    node.dataset.muted = member.isMuted ? '1' : '0';
    node.classList.add('is-active');
    if (isMe) node.classList.add('is-me');
    if (member.handUp) node.classList.add('is-hand');
    if (member.isLocked) node.classList.add('is-locked');

    const ring = el('div', { class: 'seat-ring' },
      el('img', { src: u.avatar || '', alt: '', loading: 'lazy' }),
    );

    // status badge — locked > hand > muted
    let badgeHtml = null;
    let badgeCls = 'seat-badge';
    if (member.isLocked) { badgeCls += ' is-lock'; badgeHtml = svg(ICON.lock, { width: 12, height: 12 }); }
    else if (member.handUp) { badgeCls += ' is-hand'; badgeHtml = svg(ICON.hand, { width: 12, height: 12 }); }
    else if (member.isMuted) { badgeCls += ' is-muted'; badgeHtml = svg(ICON.micOff, { width: 12, height: 12 }); }
    if (badgeHtml) ring.append(el('div', { class: badgeCls, html: badgeHtml }));

    node.append(
      ring,
      el('div', { class: 'seat-name', text: (isMe ? 'You' : u.displayName) || 'Guest' }),
    );

    node.addEventListener('click', () => onSeatTap(index, member));
    return node;
  }

  /** Tapping a seat: take it if free, otherwise open the user's menu. */
  function onSeatTap(index, member) {
    haptic();
    if (!member) {
      if (amSpeaker()) return toast('Leave your seat first');
      App.socket.emit('seat:take', { index }, (res) => {
        if (!res?.ok) return toast(res?.error || 'Could not take that seat', 'err');
        toast('You are on the mic — tap the mic button to speak', 'ok');
        unlockAudio();
      });
      return;
    }
    if (member.userId === App.user.id) {
      if (isHost()) return openHostControls();
      return toggleMic();
    }
    openUserSheet(member);
  }

  async function unlockAudio() {
    try { await voice?.unlockAudio(); } catch (_) {}
  }
  document.addEventListener('click', () => { if (voice) voice.unlockAudio(); }, { once: true });

  // ── mic button ───────────────────────────────────────────────────────────
  async function toggleMic() {
    if (!room) return;
    haptic();

    if (!amSpeaker()) {
      App.socket.emit('seat:take', {}, async (res) => {
        if (!res?.ok) return toast(res?.error || 'No free mic seats', 'err');
        applyPeers(res);
        App.socket.emit('seat:mute', { muted: false }, (m) => {
          if (m?.ok) {
            micBtn.classList.add('is-live', 'is-speaker');
            micLabel.textContent = 'On mic';
            toast('You are live — start talking 🎙️', 'ok');
          }
        });
        unlockAudio();
      });
      return;
    }

    const mine = room.members.find((m) => m.userId === App.user.id);
    const nextMuted = !mine?.isMuted;
    App.socket.emit('seat:mute', { muted: nextMuted }, (res) => {
      if (!res?.ok) return toast(res?.error || 'Could not change mic', 'err');
      micBtn.classList.toggle('is-muted', nextMuted);
      micLabel.textContent = nextMuted ? 'Tap to unmute' : 'On mic';
    });
  }

  micBtn.addEventListener('click', () => {
    if (isHost() && amSpeaker() && room?.isOwner) {
      // host long-press opens controls; a plain tap still toggles the mic
    }
    toggleMic();
  });

  // leave the mic / seat entirely via long-press
  let pressTimer = null;
  micBtn.addEventListener('pointerdown', () => {
    pressTimer = setTimeout(() => {
      if (!amSpeaker()) return;
      App.socket.emit('seat:leave', {}, (res) => {
        if (!res?.ok) return toast(res?.error || 'Could not leave the seat', 'err');
        toast('You moved to the audience');
      });
      haptic(30);
    }, 550);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) =>
    micBtn.addEventListener(evt, () => clearTimeout(pressTimer)));

  // ── hand / chat / gift / share ───────────────────────────────────────────
  handBtn.addEventListener('click', () => {
    haptic();
    const mine = room?.members.find((m) => m.userId === App.user.id);
    App.socket.emit('hand:raise', { up: !mine?.handUp }, (res) => {
      if (!res?.ok) return toast(res?.error || 'Could not raise hand', 'err');
      toast(res.up ? 'Hand raised ✋ the host can see you' : 'Hand lowered');
      handBtn.classList.toggle('is-on', res.up);
    });
  });

  $('#chatBtn').addEventListener('click', () => {
    inputBar.hidden = !inputBar.hidden;
    $('#roomActions').classList.toggle('is-typing', !inputBar.hidden);
    if (!inputBar.hidden) {
      setTimeout(() => input.focus(), 60);
      roomScroll.scrollTop = roomScroll.scrollHeight;
    }
  });

  $('#giftBtn').addEventListener('click', openGiftSheet);

  $('#shareBtn').addEventListener('click', async () => {
    if (!room) return;
    const id = shortId(room.id);
    const text = `Join my room "${room.title}" on MK Malik — room ID ${id}`;
    try {
      if (navigator.share) await navigator.share({ title: 'MK Malik', text, url: location.href });
      else { await navigator.clipboard.writeText(`${text} — ${location.href}`); toast('Invite copied', 'ok'); }
    } catch (_) {}
  });

  inputBar.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    App.socket.emit('chat:send', { body }, (res) => {
      if (!res?.ok) toast(res?.error || 'Message not sent', 'err');
    });
  });

  // ── host controls ────────────────────────────────────────────────────────
  $('#roomMore').addEventListener('click', openHostControls);

  function openHostControls() {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '';
    const host = isHost();

    panel.append(el('div', { class: 'sheet-grip' }), el('div', { class: 'sheet-title', text: host ? 'Room controls' : 'Room info' }));
    const list = el('div', { class: 'sheet-list' });

    const row = (icon, label, hint, onClick, danger) => {
      const r = el('button', { class: 'sheet-row' + (danger ? ' is-danger' : '') },
        el('span', { class: 'menu-ic', html: svg(icon, { width: 17, height: 17 }) }),
        el('span', { class: 'sheet-row-main' },
          el('span', { class: 'sheet-row-label', text: label }),
          hint ? el('span', { class: 'sheet-row-hint', text: hint }) : null,
        ),
        el('span', { class: 'menu-chev', html: svg(ICON.chev, { width: 16, height: 16 }) }),
      );
      r.addEventListener('click', () => { sheet.hidden = true; onClick(); });
      return r;
    };

    if (host) {
      list.append(
        row(ICON.lock, room.locked ? 'Unlock the room' : 'Lock the room',
          room.locked ? 'People can join again' : 'Stop new people from joining',
          () => App.socket.emit('room:update', { locked: !room.locked })),
        row(ICON.edit, 'Edit room title', room.title, () => {
          const t = prompt('Room title', room.title);
          if (t && t.trim()) App.socket.emit('room:update', { title: t.trim() });
        }),
      );
      const lockedSeats = room.seats.filter((s) => s?.isLocked).length;
      if (lockedSeats) {
        list.append(row(ICON.lock, `Unlock ${lockedSeats} seat(s)`, 'Reopen them for the audience', () => {
          room.seats.forEach((s, i) => { if (s?.isLocked) App.socket.emit('seat:lock', { index: i, locked: false }); });
        }));
      }
      list.append(el('div', { class: 'sheet-sep' }));
    }

    list.append(
      row(ICON.users, `${room.speakers}/10 on mic`, `${room.listeners} listening in the audience`, () => {}),
      row(ICON.share, 'Share invite', 'Copy the room link', () => $('#shareBtn').click()),
      row(ICON.clock, 'Room ID', shortId(room.id), () => {
        navigator.clipboard?.writeText(shortId(room.id)).then(() => toast('Room ID copied', 'ok')).catch(() => {});
      }),
    );

    if (host) {
      list.append(el('div', { class: 'sheet-sep' }));
      list.append(row(ICON.logout, 'End room for everyone', 'Closes the room immediately', () => {
        if (confirm('End the room for everyone?')) {
          App.socket.emit('room:end', {}, () => { root.hidden = true; teardownVoice(); });
        }
      }, true));
    }

    list.append(el('div', { class: 'sheet-sep' }));
    list.append(row(ICON.logout, 'Leave the room', '', () => leaveRoom('left'), !host));

    panel.append(list);
    sheet.hidden = false;
  }

  // ── per-user sheet (host moderation) ─────────────────────────────────────
  function openUserSheet(member) {
    const panel = $('#sheetPanel');
    const sheet = $('#sheet');
    panel.innerHTML = '';
    const host = isHost();

    panel.append(
      el('div', { class: 'sheet-grip' }),
      el('div', { class: 'gift-head', style: { paddingBottom: '4px' } },
        el('img', { class: 'avatar avatar--md', src: member.user?.avatar || '', alt: '' }),
        el('div', { style: { flex: '1', minWidth: '0' } },
          el('div', { style: { fontSize: '16px', fontWeight: '800' }, text: member.user?.displayName || 'Guest' }),
          el('div', { style: { fontSize: '12px', color: 'var(--ink-3)', marginTop: '2px' },
            text: `ID ${shortId(member.userId)} · Lv.${member.user?.level || 1}${member.isMuted ? ' · mic muted' : ''}` }),
        ),
      ),
    );

    const list = el('div', { class: 'sheet-list' });
    const row = (icon, label, hint, onClick, danger) => {
      const r = el('button', { class: 'sheet-row' + (danger ? ' is-danger' : '') },
        el('span', { class: 'menu-ic', html: svg(icon, { width: 17, height: 17 }) }),
        el('span', { class: 'sheet-row-main' },
          el('span', { class: 'sheet-row-label', text: label }),
          hint ? el('span', { class: 'sheet-row-hint', text: hint }) : null,
        ),
      );
      r.addEventListener('click', () => { sheet.hidden = true; onClick(); });
      return r;
    };

    list.append(
      row(ICON.gift, 'Send a gift', 'Roses, crowns, dragons…', () => {
        currentGiftTarget = member;
        openGiftSheet();
      }),
      row(ICON.comment, 'Message privately', '', () => {
        sheet.hidden = true;
        App.events.emit('dm:open', member.userId);
      }),
      row(ICON.user, 'View profile', '', () => {
        sheet.hidden = true;
        App.events.emit('view-profile', member.userId);
      }),
    );

    if (host && member.userId !== room.ownerId) {
      list.append(el('div', { class: 'sheet-sep' }));
      list.append(
        row(ICON.lock, member.isLocked ? 'Unlock this seat' : 'Lock this seat',
          'Locked seats can only be taken by invite',
          () => App.socket.emit('seat:lock', { index: member.seat, locked: !member.isLocked })),
        row(ICON.micOff, 'Mute this seat', 'Force-mute the microphone', () => {
          App.socket.emit('seat:kick', { userId: member.userId, ban: false });
        }),
        row(ICON.close, 'Remove from mic', 'They stay as a listener', () => {
          App.socket.emit('seat:kick', { userId: member.userId, ban: false });
        }, true),
      );
    }

    panel.append(list);
    sheet.hidden = false;
  }

  // ── gifts ────────────────────────────────────────────────────────────────
  let giftCatalog = null;
  let currentGiftTarget = null;
  let selectedGift = null;
  let giftQty = 1;

  async function openGiftSheet() {
    const panel = $('#giftPanel');
    const sheet = $('#giftSheet');
    panel.innerHTML = '';
    panel.append(el('div', { class: 'sheet-grip' }));

    if (!giftCatalog) {
      try { giftCatalog = (await api.gifts()).gifts; }
      catch (e) { return toast(e.message, 'err'); }
    }

    const speakers = (room?.members || []).filter((m) => m.seat !== null && m.userId !== App.user.id);
    if (!currentGiftTarget) {
      currentGiftTarget = speakers.find((m) => m.userId === room?.ownerId) || speakers[0] || null;
    }
    if (!currentGiftTarget) {
      panel.append(el('div', { class: 'sheet-title', text: 'No one to gift yet' }),
        el('div', { class: 'sheet-sub', text: 'Wait for someone to take a mic seat.' }));
      sheet.hidden = false;
      return;
    }

    // target picker
    const targetBar = el('div', { style: { display: 'flex', gap: '8px', overflowX: 'auto', padding: '0 16px 12px' } });
    speakers.forEach((m) => {
      const on = m.userId === currentGiftTarget.userId;
      const chip = el('button', {
        class: 'btn btn--sm ' + (on ? 'btn--primary' : 'btn--ghost'),
        style: { display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '5px' },
        onclick: () => { currentGiftTarget = m; openGiftSheet(); },
      },
        el('img', { class: 'avatar avatar--xs', style: { width: '22px', height: '22px' }, src: m.user?.avatar || '', alt: '' }),
        el('span', { text: m.user?.displayName || 'Guest' }),
      );
      targetBar.append(chip);
    });

    panel.append(
      el('div', { class: 'gift-head' },
        el('div', { style: { fontSize: '17px', fontWeight: '800' }, text: 'Send a gift' }),
        el('div', { class: 'gift-wallet', id: 'giftWallet' },
          el('span', { html: svg(ICON.coin, { width: 15, height: 15 }) }),
          el('span', { text: compact(App.wallet.coins) }),
        ),
      ),
      targetBar,
    );

    const grid = el('div', { class: 'gift-grid' });
    const drawGrid = () => {
      grid.innerHTML = '';
      giftCatalog.forEach((g) => {
        grid.append(el('button', {
          class: 'gift-cell' + (selectedGift?.id === g.id ? ' is-sel' : ''),
          onclick: () => { selectedGift = g; drawGrid(); drawFoot(); },
        },
          el('span', { class: 'gift-emoji', text: g.emoji }),
          el('span', { class: 'gift-name', text: g.name }),
          el('span', { class: 'gift-price', html: svg(ICON.coin, { width: 11, height: 11 }) + compact(g.price) }),
        ));
      });
    };
    panel.append(grid);

    const foot = el('div', { class: 'gift-foot' });
    function drawFoot() {
      foot.innerHTML = '';
      const qty = el('div', { class: 'qty' },
        el('button', { type: 'button', text: '−', onclick: () => { giftQty = Math.max(1, giftQty - 1); drawFoot(); } }),
        el('span', { text: String(giftQty) }),
        el('button', { type: 'button', text: '+', onclick: () => { giftQty = Math.min(99, giftQty + 1); drawFoot(); } }),
      );
      const total = (selectedGift?.price || 0) * giftQty;
      const send = el('button', {
        class: 'btn btn--primary', style: { flex: '1' },
        text: selectedGift ? `Send ${selectedGift.emoji} · ${compact(total)}` : 'Pick a gift',
      });
      send.disabled = !selectedGift;
      send.addEventListener('click', () => {
        send.disabled = true;
        App.socket.emit('gift:send', {
          giftId: selectedGift.id, toUserId: currentGiftTarget.userId, qty: giftQty,
        }, (res) => {
          if (!res?.ok) {
            toast(res?.error || 'Gift failed', 'err');
            send.disabled = false;
            return;
          }
          App.setWallet({ coins: res.coins });
          const w = panel.querySelector('#giftWallet span:last-child');
          if (w) w.textContent = compact(res.coins);
          toast(`${selectedGift.emoji} sent to ${currentGiftTarget.user?.displayName}`, 'ok');
          send.disabled = false;
        });
      });
      foot.append(qty, send);
    }

    selectedGift = selectedGift || giftCatalog[0];
    drawGrid();
    drawFoot();
    panel.append(foot);
    sheet.hidden = false;
  }

  // ── socket events ────────────────────────────────────────────────────────
  const socketHandlers = {
    'room:state': (snap) => {
      if (!snap || snap.id !== room?.id) return;
      room = { ...room, ...snap };
      renderRoom();
      renderSeats();
      if (App.current !== 'room') { /* keep background state fresh */ }
    },

    'room:message': (msg) => {
      appendMessage(msg);
    },

    'room:seat': (p) => {
      if (!room) return;
      const idx = p.seat;
      if (typeof idx === 'number') {
        // rebuild from the incoming member where possible
        const existing = room.seats.map((s) => s);
        if (p.member) existing[idx] = p.member.seat === null ? null : p.member;
        else existing[idx] = null;
        room.seats = existing;
      }
      renderSeats();
      if (p.promoted && p.userId === App.user?.id) {
        toast('You were moved up to the mic 🎙️', 'ok');
        App.socket.emit('room:snapshot', {}, applyPeers);
      }
    },

    'room:seatlock': (p) => { if (room && room.seats[p.seat]) room.seats[p.seat].isLocked = p.locked; renderSeats(); },

    'room:hand': (p) => {
      if (!room) return;
      const m = room.members.find((x) => x.userId === p.userId);
      if (m) m.handUp = p.up;
      if (room.seats) room.seats.forEach((s) => { if (s && s.userId === p.userId) s.handUp = p.up; });
      renderSeats();
    },

    'room:speaking': (p) => {
      const node = seatsWrap.querySelector(`.seat[data-user="${p.userId}"]`);
      if (node) node.classList.toggle('is-speaking', p.speaking && node.dataset.muted !== '1');
      if (room) {
        const m = room.members.find((x) => x.userId === p.userId);
        if (m) m.speaking = p.speaking;
      }
    },

    'room:gift': (g) => {
      playGiftFx(g);
      if (g.to?.userId === App.user?.id) haptic(30);
    },

    'room:member_join': (p) => { if (room) { room.members = p.room?.members || room.members; renderRoom(); renderSeats(); } },
    'room:member_leave': (p) => { if (room) { room.members = p.room?.members || room.members; renderRoom(); renderSeats(); } },

    'seat:granted': (p) => {
      if (p.roomId !== room?.id) return;
      toast('A mic seat opened up for you 🎙️', 'ok');
      App.socket.emit('room:snapshot', {}, applyPeers);
    },
    'seat:revoked': (p) => {
      if (p.roomId !== room?.id) return;
      toast(p.reason === 'banned' ? 'You were removed by the host' : 'The host moved you off the mic', 'err');
      voice?.goListener();
      App.socket.emit('room:snapshot', {}, applyPeers);
    },

    'room:closed': (p) => {
      if (!room) return;
      toast(p.reason === 'host_ended' ? 'The host ended the room' : 'Room closed');
      teardownVoice();
      root.hidden = true;
      room = null;
      App.events.emit('rooms:refresh');
    },

    // personalised peer list — this is what actually builds/tears down audio
    'room:peers': (p) => {
      if (!room || p.roomId !== room.id) return;
      voice?.syncPeers(p.peers || []).catch(() => {});
    },
  };

  let socketAttached = null;   // the socket we have already bound handlers to

  function attachSocket() {
    const s = App.socket;
    if (!s || socketAttached === s) return;   // never double-bind
    socketAttached = s;

    for (const [evt, fn] of Object.entries(socketHandlers)) s.on(evt, fn);

    s.on('disconnect', () => {
      if (!root.hidden) toast('Connection lost — reconnecting…', 'err');
    });
    s.on('connect', () => {
      // re-establish membership + audio after a network blip
      if (!root.hidden && room) {
        s.emit('room:join', { roomId: room.id, pin }, (res) => {
          if (res?.ok) { room = res.room; renderRoom(); renderSeats(); startVoice(res.peers || []); }
        });
      }
    });
  }

  // socket is created later by app.js; hook as soon as it exists
  App.events.on('started', attachSocket);
  App.events.on('socket', ({ connected }) => { if (connected) attachSocket(); });

  // ── chat rendering ───────────────────────────────────────────────────────
  function renderChat(reset) {
    chatLog.innerHTML = '';
    if (!room) return;
    (room.messages || []).slice(-50).forEach((m) => appendMessage(m, true));
    if (reset) requestAnimationFrame(() => { roomScroll.scrollTop = roomScroll.scrollHeight; });
  }

  function appendMessage(msg, quiet) {
    const isMe = msg.userId === App.user?.id;
    const isSystem = msg.kind === 'system' || msg.kind === 'join' || msg.kind === 'leave';
    const isGift = msg.kind === 'gift';

    const cls = ['chat-msg'];
    if (isMe) cls.push('is-me');
    if (isSystem) cls.push('is-system');
    if (isGift) cls.push('is-gift');
    if (msg.user?.vip) cls.push('is-vip');

    const node = el('div', { class: cls.join(' ') });
    if (!isSystem) node.append(el('img', { src: msg.user?.avatar || '', alt: '', loading: 'lazy' }));

    const body = el('div', { class: 'chat-msg-body' });
    if (!isSystem) {
      body.append(el('div', { class: 'chat-msg-name', text: isMe ? 'You' : (msg.user?.displayName || 'Guest') }));
    }
    body.append(el('div', { class: 'chat-msg-text', text: msg.body }));
    node.append(body);

    chatLog.append(node);
    if (chatLog.children.length > 120) chatLog.firstElementChild.remove();

    const nearBottom = roomScroll.scrollHeight - roomScroll.scrollTop - roomScroll.clientHeight < 220;
    if (nearBottom || isMe) requestAnimationFrame(() => { roomScroll.scrollTop = roomScroll.scrollHeight; });
  }

  // ── gift animation ───────────────────────────────────────────────────────
  function playGiftFx(g) {
    const layer = $('#fxLayer');
    if (!layer) return;
    const fx = el('div', { class: 'fx-gift' },
      el('div', { class: 'fx-gift-emoji', text: g.gift.emoji }),
      el('div', { class: 'fx-gift-label', text: `${g.from?.displayName || 'Someone'} → ${g.to?.user?.displayName || ''} ×${g.qty}` }),
    );
    layer.append(fx);
    setTimeout(() => fx.remove(), 2800);

    // burst of small emoji
    for (let i = 0; i < Math.min(8, g.qty + 3); i++) {
      const b = el('div', {
        class: 'fx-bubble',
        text: g.gift.emoji,
        style: {
          left: (12 + Math.random() * 76) + '%',
          bottom: (16 + Math.random() * 40) + '%',
          animationDelay: (i * 90) + 'ms',
        },
      });
      layer.append(b);
      setTimeout(() => b.remove(), 2400 + i * 90);
    }
  }

  // ── keyboard: ESC leaves the room ────────────────────────────────────────
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !root.hidden) leaveRoom('left');
  });

  // clean up if the tab is closed mid-room
  window.addEventListener('pagehide', () => { if (room) App.socket?.emit('room:leave', {}); });

  // ── public-ish API for other screens ─────────────────────────────────────
  App.room = {
    get current() { return room; },
    joinByInvite: (roomId, pinCode) => App.events.emit('room:open', { roomId, pin: pinCode }),
  };

  return { leaveRoom };
}
