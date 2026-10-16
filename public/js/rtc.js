/* ---------------------------------------------------------------------------
   WebRTC voice engine.

   Topology: full mesh between everyone who is on a mic seat. Listeners open a
   receive-only connection to each speaker, so they hear the room without ever
   sending audio.

   Glare is avoided with the "perfect negotiation" pattern: the peer whose id
   sorts lower is the polite one and rolls back on collision.

   All signalling goes through the Socket.IO server (rtc:signal); media is
   peer-to-peer and never touches the server.
   --------------------------------------------------------------------------- */

/* ICE servers come from the server (/api/ice-servers) so TURN credentials stay
   server-side. The defaults below are only a fallback if that call fails. */
import { apiBase } from './runtime.js';

let ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
let iceLoaded = null;

/** Fetch (once) the ICE configuration from our own backend. */
export async function loadIceServers() {
  if (iceLoaded) return iceLoaded;
  iceLoaded = (async () => {
    try {
      const res = await fetch(apiBase() + '/ice-servers');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const { iceServers } = await res.json();
      if (Array.isArray(iceServers) && iceServers.length) {
        ICE_SERVERS = iceServers;
        const hasTurn = iceServers.some((s) => String(s.urls).includes('turn'));
        console.info(`[rtc] ICE ready — ${iceServers.length} server(s)${hasTurn ? ' (TURN relay available)' : ' (STUN only)'}`);
      }
    } catch (e) {
      console.warn('[rtc] using built-in STUN defaults:', e.message);
    }
    return ICE_SERVERS;
  })();
  return iceLoaded;
}

export const iceServers = () => ICE_SERVERS;

export class VoiceEngine {
  constructor(socket, { onSpeaking, onState, onLevel, onRemoteStream } = {}) {
    this.socket = socket;
    this.onSpeaking = onSpeaking || (() => {});
    this.onState = onState || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onRemoteStream = onRemoteStream || (() => {});

    this.localStream = null;
    this.pcMap = new Map();       // userId -> RTCPeerConnection
    this.audioMap = new Map();    // userId -> HTMLAudioElement
    this.direction = new Map();   // userId -> 'sendrecv' | 'sendonly' | 'recvonly'
    this.isSpeaker = false;
    this.muted = true;
    this.levelTimer = null;
    this.audioCtx = null;
    this.analyser = null;
    this.rafId = null;
    this._speakingState = false;
    this._lastEmit = 0;
    this.destroyed = false;

    socket.on('rtc:signal', ({ from, data }) => this._onSignal(from, data));
  }

  // ── local capture ────────────────────────────────────────────────────────
  async ensureMic() {
    if (this.localStream && this.localStream.getAudioTracks().some((t) => t.readyState === 'live')) {
      return this.localStream;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot capture audio (needs HTTPS or localhost)');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    this.localStream = stream;
    // A track ending (device unplugged / permission revoked) forces a re-acquire.
    stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => {
      this.localStream = null;
      this.onState('mic-lost');
    }));
    this._attachAnalyser(stream);
    this._applyMuteToTracks();
    return stream;
  }

  _applyMuteToTracks() {
    if (!this.localStream) return;
    const on = !this.muted && this.isSpeaker;
    this.localStream.getAudioTracks().forEach((t) => { t.enabled = on; });
  }

  setMuted(muted) {
    this.muted = !!muted;
    this._applyMuteToTracks();
  }

  /** Become a publisher. Creates the local stream and (re)negotiates. */
  async goLive() {
    this.isSpeaker = true;
    await this.ensureMic();
    this._applyMuteToTracks();
    await this.renegotiateAll();
    this.onState('live');
  }

  /** Stop publishing but keep listening. */
  async goListener() {
    this.isSpeaker = false;
    this._applyMuteToTracks();
    // release the microphone hardware — a listener should not hold the mic
    this._stopLevelMeter();
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    for (const [peerId, pc] of this.pcMap) {
      // speaker -> listener is still valid, so renegotiate instead of dropping
      await this._renegotiate(peerId, pc).catch(() => {});
    }
    this.onState('listener');
  }

  // ── peer management ──────────────────────────────────────────────────────
  /** Sync the connection set to exactly `peers` (from the server payload). */
  async syncPeers(peers) {
    const wanted = new Set(peers.map((p) => p.userId));
    for (const [id] of this.pcMap) {
      if (!wanted.has(id)) this._dropPeer(id);
    }
    for (const peer of peers) {
      this.direction.set(peer.userId, peer.direction);
      const shouldPublish = peer.direction === 'sendrecv' || peer.direction === 'sendonly';
      if (shouldPublish && this.isSpeaker) { try { await this.ensureMic(); } catch (_) {} }

      let pc = this.pcMap.get(peer.userId);
      if (pc && (this._pcWantsAudio(pc) !== shouldPublish)) {
        this._dropPeer(peer.userId);
        pc = null;
      }
      if (!pc) {
        pc = this._createPeer(peer.userId, shouldPublish, peer.initiator);
        this.pcMap.set(peer.userId, pc);
      }
    }
  }

  _pcWantsAudio(pc) {
    return pc.getTransceivers().some((t) => {
      const k = t.receiver?.track?.kind || t.sender?.track?.kind;
      return k === 'audio' && (t.direction === 'sendrecv' || t.direction === 'sendonly');
    });
  }

  _createPeer(peerId, publish, initiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });
    pc._peerId = peerId;
    pc._publish = publish;
    pc._makingOffer = false;
    pc._ignoreOffer = false;
    pc._polite = String(this.socket.id || '') > String(peerId); // deterministic-ish
    pc._pendingCandidates = [];

    if (publish && this.localStream) {
      const track = this.localStream.getAudioTracks()[0];
      if (track) pc.addTrack(track, this.localStream);
    }
    if (!publish) {
      // receive-only: declare a recvonly audio transceiver up front
      try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch (_) {}
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._signal(peerId, { type: 'candidate', candidate });
    };

    pc.ontrack = ({ streams, track }) => {
      const stream = streams[0] || new MediaStream([track]);
      this._attachRemoteAudio(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed') {
        try { pc.restartIce(); } catch (_) {}
      }
      if (st === 'closed') this.onState('peer-closed');
      if (st === 'connected') this.onState('peer-connected');
    };

    pc.onnegotiationneeded = async () => {
      try {
        pc._makingOffer = true;
        await pc.setLocalDescription();
        this._signal(peerId, { type: 'description', description: pc.localDescription });
      } catch (e) {
        console.warn('[rtc] negotiation failed', e.message);
      } finally {
        pc._makingOffer = false;
      }
    };

    if (initiator) {
      // nudge a first negotiation on the next tick
      setTimeout(() => { if (!pc._makingOffer && pc.signalingState === 'stable') pc.onnegotiationneeded?.(); }, 60);
    }
    return pc;
  }

  async _onSignal(from, data) {
    if (this.destroyed) return;
    let pc = this.pcMap.get(from);
    if (!pc) {
      const dir = this.direction.get(from) || (this.isSpeaker ? 'sendrecv' : 'recvonly');
      const publish = dir === 'sendrecv' || dir === 'sendonly';
      if (publish && this.isSpeaker) { try { await this.ensureMic(); } catch (_) {} }
      pc = this._createPeer(from, publish, false);
      this.pcMap.set(from, pc);
    }

    try {
      if (data.type === 'description') {
        const desc = data.description;
        const offerCollision = desc.type === 'offer' && (pc._makingOffer || pc.signalingState !== 'stable');
        pc._ignoreOffer = !pc._polite && offerCollision;
        if (pc._ignoreOffer) return;
        if (offerCollision) await pc.setLocalDescription({ type: 'rollback' });
        await pc.setRemoteDescription(desc);
        for (const c of pc._pendingCandidates.splice(0)) {
          await pc.addIceCandidate(c).catch(() => {});
        }
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          this._signal(from, { type: 'description', description: pc.localDescription });
        }
      } else if (data.type === 'candidate' && data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else pc._pendingCandidates.push(data.candidate);
      }
    } catch (e) {
      if (!pc._ignoreOffer) console.warn('[rtc] signal error', e.message);
    }
  }

  _signal(to, data) {
    this.socket.emit('rtc:signal', { to, data });
  }

  async _renegotiate(peerId, pc) {
    if (pc.signalingState !== 'stable') return;
    await pc.setLocalDescription();
    this._signal(peerId, { type: 'description', description: pc.localDescription });
  }

  async renegotiateAll() {
    for (const [peerId, pc] of this.pcMap) {
      const dir = this.direction.get(peerId) || 'sendrecv';
      const publish = dir === 'sendrecv' || dir === 'sendonly';
      if (publish && this.localStream) {
        const track = this.localStream.getAudioTracks()[0];
        const sender = pc.getSenders().find((s) => s.track?.kind === 'audio' || !s.track);
        if (track) {
          if (sender) { try { await sender.replaceTrack(track); } catch (_) { try { pc.addTrack(track, this.localStream); } catch (_) {} } }
          else { try { pc.addTrack(track, this.localStream); } catch (_) {} }
        }
      }
      await this._renegotiate(peerId, pc).catch(() => {});
    }
  }

  _dropPeer(peerId) {
    const pc = this.pcMap.get(peerId);
    if (pc) { try { pc.onicecandidate = null; pc.ontrack = null; pc.close(); } catch (_) {} }
    this.pcMap.delete(peerId);
    const audio = this.audioMap.get(peerId);
    if (audio) { audio.srcObject = null; audio.remove(); this.audioMap.delete(peerId); }
  }

  async renegotiateWith(peerId) {
    const pc = this.pcMap.get(peerId);
    if (pc) await this._renegotiate(peerId, pc).catch(() => {});
  }

  // ── remote playback ──────────────────────────────────────────────────────
  _attachRemoteAudio(peerId, stream) {
    let audio = this.audioMap.get(peerId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audio.playsInline = true;
      audio.setAttribute('playsinline', '');
      audio.dataset.peer = peerId;
      document.body.appendChild(audio);
      this.audioMap.set(peerId, audio);
    }
    audio.srcObject = stream;
    audio.volume = 1;
    audio.play().catch(() => {
      // Autoplay policy — surface it so the UI can ask for a tap.
      this.onState('autoplay-blocked');
    });
    this.onRemoteStream(peerId, stream);
  }

  /** Called from a user gesture to unblock audio playback. */
  async unlockAudio() {
    for (const audio of this.audioMap.values()) {
      try { await audio.play(); } catch (_) {}
    }
  }

  // ── local level / speaking detection ─────────────────────────────────────
  _attachAnalyser(stream) {
    try {
      if (!this.audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new Ctx();
      }
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      const src = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      src.connect(analyser);
      this.analyser = analyser;
      this._buf = new Uint8Array(analyser.frequencyBinCount);
      this._startLevelMeter();
    } catch (e) {
      console.warn('[rtc] analyser unavailable', e.message);
    }
  }

  _startLevelMeter() {
    if (this.rafId) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(this._buf);
      let sum = 0;
      for (let i = 2; i < 60; i++) sum += this._buf[i];
      const level = Math.min(1, (sum / 58) / 130);
      this.onLevel(level);

      const speaking = this.isSpeaker && !this.muted && level > 0.16;
      const t = performance.now();
      if (speaking !== this._speakingState && t - this._lastEmit > 220) {
        this._speakingState = speaking;
        this._lastEmit = t;
        this.onSpeaking(speaking);
        this.socket.emit('rtc:speaking', { speaking });
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  _stopLevelMeter() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.analyser = null;
    this.onLevel(0);
    if (this._speakingState) {
      this._speakingState = false;
      this.onSpeaking(false);
      this.socket.emit('rtc:speaking', { speaking: false });
    }
  }

  // ── diagnostics ──────────────────────────────────────────────────────────
  async stats() {
    const out = [];
    for (const [peerId, pc] of this.pcMap) {
      const report = await pc.getStats().catch(() => null);
      let rtt = null, jitter = null, lost = null, codec = null;
      report?.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded') rtt = Math.round((r.currentRoundTripTime || 0) * 1000);
        if (r.type === 'inbound-rtp' && r.kind === 'audio') { jitter = r.jitter ? Math.round(r.jitter * 1000) : null; lost = r.packetsLost; }
        if (r.type === 'codec' && r.mimeType) codec = r.mimeType.replace('audio/', '');
      });
      out.push({ peerId, state: pc.connectionState, rtt, jitter, lost, codec });
    }
    return out;
  }

  // ── teardown ─────────────────────────────────────────────────────────────
  destroy() {
    this.destroyed = true;
    this._stopLevelMeter();
    for (const id of [...this.pcMap.keys()]) this._dropPeer(id);
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    try { this.audioCtx?.close(); } catch (_) {}
    this.audioCtx = null;
  }
}

/** Ring-buffer of remote audio levels (for per-speaker indicators). */
export class RemoteLevels {
  constructor() {
    this.ctx = null;
    this.nodes = new Map();
    this.buf = new Uint8Array(256);
    this.levels = new Map();
    this.rafId = null;
    this.onUpdate = () => {};
  }
  attach(peerId, stream) {
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const src = this.ctx.createMediaStreamSource(stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      src.connect(analyser);
      this.nodes.set(peerId, analyser);
      if (!this.rafId) this._tick();
    } catch (_) {}
  }
  detach(peerId) { this.nodes.delete(peerId); this.levels.delete(peerId); }
  _tick() {
    this.rafId = requestAnimationFrame(() => this._tick());
    let changed = false;
    for (const [peerId, analyser] of this.nodes) {
      analyser.getByteFrequencyData(this.buf);
      let sum = 0;
      for (let i = 2; i < 48; i++) sum += this.buf[i];
      const level = Math.min(1, (sum / 46) / 130);
      const prev = this.levels.get(peerId) || 0;
      if (Math.abs(level - prev) > 0.05) { this.levels.set(peerId, level); changed = true; }
    }
    if (changed) this.onUpdate(this.levels);
  }
  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    try { this.ctx?.close(); } catch (_) {}
  }
}
