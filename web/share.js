'use strict';
/* Funkraum – Bildschirm teilen (screen sharing).
 *
 * Used by the web interface (app.js), the desktop app and the stand-alone
 * page /screen. A TeamSpeak server cannot carry video, so the picture goes
 * through a Funkraum-Web bridge instead (WebSocket /share/ws, see share.rs):
 *
 *   getDisplayMedia → VideoEncoder (VP8/H.264) ──WebSocket──▶ bridge ──▶ VideoDecoder → <canvas>
 *   tab/system sound → AudioEncoder (Opus)    ──────────────▶ bridge ──▶ AudioDecoder → speakers
 *
 * Everybody in the same room (TeamSpeak server + channel) sees the screens
 * shared there. The bridge only copies the encoded packets.
 */
(() => {
  const KIND_KEY = 1, KIND_DELTA = 2, KIND_AUDIO = 3;
  /** A key frame at least this often (ms), so new viewers and lost frames recover. */
  const KEY_INTERVAL = 4000;
  /** Stop encoding while this much is still waiting to be sent (bytes). */
  const MAX_BUFFERED = 1.5 * 1024 * 1024;
  /** Largest message the bridge accepts (share.rs MAX_MESSAGE). */
  const MAX_MESSAGE = 2 * 1024 * 1024 - 64;
  /** Audio playback delay (s) that evens out network jitter. */
  const AUDIO_LEAD = 0.12;

  const QUALITIES = {
    720: { label: '720p', w: 1280, h: 720 },
    1080: { label: '1080p (empfohlen)', w: 1920, h: 1080 },
    1440: { label: '1440p', w: 2560, h: 1440 },
    max: { label: 'Original (bis 4K)', w: 3840, h: 2160 },
  };
  const FPS = [5, 15, 30, 60];

  const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICON = {
    screen: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
    screenOff: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M9 8l6 4M15 8l-6 4"/>'),
    speaker: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),
    speakerOff: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>'),
    full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  };

  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  };
  const toB64 = (buf) => {
    const u8 = buf instanceof Uint8Array ? buf : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (str) => { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tsweb.share.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('tsweb.share.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  /** What this browser / web view can do. */
  function support() {
    const md = navigator.mediaDevices;
    const chromium = !!window.MediaStreamTrackProcessor;
    return {
      send: !!(window.isSecureContext && md && md.getDisplayMedia && window.VideoEncoder && window.VideoFrame),
      view: !!(window.VideoDecoder && window.EncodedVideoChunk),
      // Sound of the shared tab/screen: only Chromium (Chrome, Edge, Opera, desktop app on Windows) delivers it.
      audio: !!(chromium && window.AudioEncoder),
      // Sound from an audio device (stereo mix, VB-Cable, second microphone …): every browser with WebCodecs.
      deviceAudio: !!(window.isSecureContext && md && md.getUserMedia && window.AudioEncoder && window.AudioData
        && (chromium || window.AudioWorkletNode)),
      // Only Chromium can share single browser tabs.
      tabs: chromium,
      audioView: !!(window.AudioDecoder && (window.AudioContext || window.webkitAudioContext)),
    };
  }

  /**
   * Address of a bridge as the user types it ("ts.example.com", "https://ts.example.com/web/")
   * → WebSocket and page address. null if it makes no sense.
   */
  function server(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!/^(https?|wss?):$/.test(u.protocol) || !u.hostname) return null;
    let path = u.pathname.replace(/share\/ws\/?$/, '').replace(/screen\/?$/, '');
    if (!path.endsWith('/')) path += '/';
    const secure = u.protocol === 'https:' || u.protocol === 'wss:';
    return {
      ws: `${secure ? 'wss' : 'ws'}://${u.host}${path}share/ws`,
      page: `${secure ? 'https' : 'http'}://${u.host}${path}screen`,
      host: u.host,
    };
  }

  /** The bridge this page comes from. */
  function here() {
    const ws = new URL('share/ws', location.href);
    ws.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.hash = ''; ws.search = '';
    const page = new URL('screen', location.href);
    page.hash = ''; page.search = '';
    return { ws: ws.href, page: page.href, host: location.host };
  }

  /** Link to the stand-alone page: watch (or with send=1: share) in a normal browser. */
  function link(srv, room, extra = {}) {
    const p = new URLSearchParams(Object.assign({ r: room }, extra));
    return `${srv.page}#${p.toString()}`;
  }

  /** Open a link in the system browser (desktop app) or a new tab. */
  function openExternal(url) {
    if (window.ipc && window.ipc.postMessage) {
      try { window.ipc.postMessage(JSON.stringify({ t: 'open-url', url })); return; } catch { /* fall through */ }
    }
    window.open(url, '_blank', 'noopener');
  }

  function errorText(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError') return 'Bildschirmfreigabe abgebrochen oder nicht erlaubt.';
    if (n === 'NotFoundError') return 'Kein Bildschirm zum Teilen gefunden.';
    if (n === 'NotReadableError') return 'Der Bildschirm kann gerade nicht aufgenommen werden (anderes Programm oder fehlende Systemberechtigung).';
    if (n === 'NotSupportedError' || n === 'TypeError') return 'Bildschirm teilen wird hier nicht unterstützt.';
    return (e && e.message) || String(e);
  }

  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    emit(ev, ...args) { for (const fn of this._h[ev] || []) { try { fn(...args); } catch (e) { console.error(e); } } }
  }

  // ------------------------------------------------------------------ session
  /**
   * Connection to one room. Options: url (WebSocket), room, name, cid, uid,
   * audioOut() → {ctx, node} for the sound, audioMuted() → bool.
   * Events: status(state), streams(list), sending(info|null), watching(), error(text), toast(text).
   */
  class Session extends Emitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.url = opts.url;
      this.room = opts.room;
      this.ws = null;
      this.id = null;
      this.state = 'idle';
      this.streams = new Map();
      this.viewers = new Map();
      this.sender = null;
      this.closed = false;
      this.retry = 0;
      this.maxKbps = 6000;
      /** Streams that ended while watched: watch them again when they come back (reconnect). */
      this.recent = new Map();
    }

    connect() { this.closed = false; if (!this.ws) this._open(); return this; }

    _setState(st, reason) { this.state = st; this.emit('status', st, reason); }

    _open() {
      clearTimeout(this._retryTimer);
      if (!this.url || !this.room) return;
      this._setState(this.retry ? 'reconnecting' : 'connecting');
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { this._setState('error', errorText(e)); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'hello', room: this.room, name: this.opts.name || '', cid: this.opts.cid ?? null, uid: this.opts.uid || null }));
      };
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        if (typeof e.data === 'string') {
          let m;
          try { m = JSON.parse(e.data); } catch { return; }
          this._text(m);
        } else this._binary(e.data);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.id = null;
        this._lost('Verbindung zur Bildschirmübertragung unterbrochen');
        if (this.closed) { this._setState('closed'); return; }
        const delay = [1000, 2000, 4000, 8000, 15000][Math.min(this.retry, 4)];
        this.retry++;
        this._setState('reconnecting');
        this._retryTimer = setTimeout(() => this._open(), delay);
      };
      clearInterval(this._ping);
      this._ping = setInterval(() => this.sendJson({ t: 'ping' }), 25000);
    }

    /** Connection gone or room changed: all watched streams end (remembered for re-watching). */
    _lost(why) {
      for (const [id, v] of this.viewers) {
        const s = this.streams.get(id);
        if (s) this.recent.set(keyOf(s), Date.now());
        v.end(why);
      }
      this.viewers.clear();
      this.streams.clear();
      this.emit('streams', []);
      this.emit('watching');
    }

    _text(m) {
      switch (m.t) {
        case 'welcome':
          this.id = m.id;
          this.retry = 0;
          if (m.max_kbps) this.maxKbps = m.max_kbps;
          this._setState('open');
          if (this.sender) this.sender.announce();
          break;
        case 'streams': {
          const list = (m.streams || []).filter((s) => s.id !== this.id);
          this.streams = new Map(list.map((s) => [s.id, s]));
          for (const [id, v] of this.viewers) {
            const s = this.streams.get(id);
            if (s) v.update(s);
          }
          const now = Date.now();
          for (const s of list) {
            const t = this.recent.get(keyOf(s));
            if (t && now - t < 60000 && !this.viewers.has(s.id)) {
              this.recent.delete(keyOf(s));
              this.watch(s.id);
            }
          }
          this.emit('streams', list);
          break;
        }
        case 'config': { const v = this.viewers.get(m.stream); if (v) v.configure(m); break; }
        case 'ended': {
          const v = this.viewers.get(m.stream);
          if (v) {
            const s = this.streams.get(m.stream);
            if (s) this.recent.set(keyOf(s), Date.now());
            v.end('Die Übertragung wurde beendet.');
            this.viewers.delete(m.stream);
            this.emit('watching');
          }
          break;
        }
        case 'keyframe': if (this.sender) this.sender.requestKey(); break;
        case 'viewers': if (this.sender) { this.sender.viewers = m.count; this.emit('sending', this.sender.info()); } break;
        case 'error':
          if (m.stream != null && this.viewers.has(m.stream)) this.viewers.get(m.stream).message(m.message);
          this.emit('error', m.message);
          break;
        default: break;
      }
    }

    _binary(buf) {
      if (buf.byteLength < 14) return;
      const dv = new DataView(buf);
      const v = this.viewers.get(dv.getUint32(0));
      if (v) v.media(dv.getUint8(4), Number(dv.getBigUint64(5)), new Uint8Array(buf, 13));
    }

    sendJson(o) {
      if (this.ws && this.ws.readyState === 1 && this.id != null) this.ws.send(JSON.stringify(o));
    }

    buffered() { return this.ws ? this.ws.bufferedAmount : Infinity; }

    sendMedia(kind, ts, chunk) {
      if (!this.ws || this.ws.readyState !== 1 || this.id == null) return false;
      const len = chunk.byteLength;
      if (len + 9 > MAX_MESSAGE) return false;
      const buf = new Uint8Array(9 + len);
      buf[0] = kind;
      new DataView(buf.buffer).setBigUint64(1, BigInt(Math.max(0, Math.round(ts))));
      chunk.copyTo(buf.subarray(9));
      this.ws.send(buf);
      return true;
    }

    /** Own TeamSpeak details changed (name, channel): the room follows, the own stream too. */
    update({ room, name, cid, uid, url }) {
      const moved = (room && room !== this.room) || (url && url !== this.url);
      if (name != null) this.opts.name = name;
      if (cid !== undefined) this.opts.cid = cid;
      if (uid !== undefined) this.opts.uid = uid;
      if (!moved) return false;
      if (room) this.room = room;
      if (url) this.url = url;
      this.recent.clear();
      const old = this.ws;
      this.ws = null;
      this.id = null;
      if (old) { try { old.close(); } catch { /* ignore */ } }
      this._lost('Du hast den Kanal gewechselt.');
      this.retry = 0;
      if (!this.closed) this._open();
      return true;
    }

    watch(id) {
      if (this.viewers.has(id)) return this.viewers.get(id);
      const s = this.streams.get(id);
      if (!s) return null;
      const v = new Viewer(this, s);
      this.viewers.set(id, v);
      this.sendJson({ t: 'watch', stream: id });
      this.emit('watching');
      return v;
    }

    unwatch(id) {
      const v = this.viewers.get(id);
      if (!v) return;
      this.viewers.delete(id);
      const s = this.streams.get(id);
      if (s) this.recent.delete(keyOf(s));
      v.end();
      this.sendJson({ t: 'unwatch', stream: id });
      this.emit('watching');
    }

    /** Start sharing (call from a click: the browser asks which screen). */
    async startSharing(opts) {
      if (this.sender) return this.sender.info();
      const sender = new Sender(this, opts || {});
      this.sender = sender;
      try {
        await sender.start();
      } catch (e) {
        if (this.sender === sender) this.sender = null;
        sender.stop();
        throw e;
      }
      this.emit('sending', sender.info());
      return sender.info();
    }

    stopSharing() {
      const s = this.sender;
      if (!s) return;
      this.sender = null;
      s.stop();
      this.sendJson({ t: 'stop' });
      this.emit('sending', null);
    }

    /** Add sound to a running share: {kind:'display'} (browser asks again) or {kind:'device', deviceId}. */
    async addAudio(source) {
      if (!this.sender) throw new Error('Du teilst gerade nichts.');
      await this.sender.addAudio(source);
      this.emit('sending', this.sender.info());
      return this.sender.info();
    }

    /** Switch the sound of the own stream; false if no sound was captured. */
    setAudio(on) {
      if (!this.sender) return false;
      const ok = this.sender.setAudio(on);
      this.emit('sending', this.sender.info());
      return ok;
    }

    close() {
      this.closed = true;
      clearTimeout(this._retryTimer);
      clearInterval(this._ping);
      this.stopSharing();
      for (const v of this.viewers.values()) v.end();
      this.viewers.clear();
      const ws = this.ws;
      this.ws = null;
      this.id = null;
      if (ws) { try { ws.close(); } catch { /* ignore */ } }
      this._setState('closed');
    }

    /** Where viewers play the sound: the app's output (chosen speaker), else an own AudioContext. */
    audioOut() {
      if (this.opts.audioOut) {
        const o = this.opts.audioOut();
        if (o && o.ctx && o.node) return o;
      }
      if (!Session._ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        Session._ctx = new Ctx({ latencyHint: 'interactive' });
      }
      const ctx = Session._ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return { ctx, node: ctx.destination };
    }
  }
  const keyOf = (s) => s.uid || `${s.name}#${s.cid ?? ''}`;

  // ------------------------------------------------------------------ sender
  class Sender {
    constructor(session, opts) {
      this.s = session;
      this.quality = QUALITIES[opts.quality] ? String(opts.quality) : '1080';
      this.fps = FPS.includes(Number(opts.fps)) ? Number(opts.fps) : 30;
      this.audioWanted = opts.audio !== false;
      this.surface = ['monitor', 'window', 'browser'].includes(opts.surface) ? opts.surface : '';
      this.running = false;
      this.viewers = 0;
      this.enc = null;
      this.aenc = null;
      this.w = 0;
      this.h = 0;
      this.lastAt = 0;
      this.lastKey = 0;
      this.forceKey = true;
      this.cfgVideo = null;
      this.cfgAudio = null;
    }

    async start() {
      const sup = support();
      if (!sup.send) throw new Error('Bildschirm teilen wird hier nicht unterstützt.');
      const q = QUALITIES[this.quality];
      const video = { frameRate: { ideal: this.fps, max: this.fps }, width: { max: q.w }, height: { max: q.h } };
      // Chromium opens its picker on this page (screen, window or tab).
      if (this.surface) video.displaySurface = this.surface;
      // Sound is asked for whenever this browser can send it, so it can be
      // switched on later without choosing the screen again.
      const audio = sup.audio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false, restrictOwnAudio: true }
        : false;
      const extra = { selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: audio ? 'include' : 'exclude' };
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(Object.assign({ video, audio }, extra));
      } catch (e) {
        if (e && e.name === 'TypeError' && audio) stream = await navigator.mediaDevices.getDisplayMedia({ video });
        else throw new Error(errorText(e));
      }
      this.stream = stream;
      this.vtrack = stream.getVideoTracks()[0];
      this.atrack = stream.getAudioTracks()[0] || null;
      if (!this.vtrack) throw new Error('Kein Bild erhalten.');
      try { this.vtrack.contentHint = this.fps >= 30 ? 'motion' : 'detail'; } catch { /* ignore */ }
      // "Freigabe beenden" in the browser's bar
      this.vtrack.addEventListener('ended', () => { if (this.s.sender === this) this.s.stopSharing(); });

      const st = this.vtrack.getSettings();
      this.codec = await this.pickCodec(even(Math.min(st.width || q.w, q.w)), even(Math.min(st.height || q.h, q.h)));
      if (!this.codec) throw new Error('Dein Browser kann kein Video kodieren (VP8/H.264). Probiere Chrome, Edge oder Firefox.');
      this.audioOn = this.audioWanted && !!this.atrack;
      this.running = true;
      if (this.s.id != null) this.announce();
      this.startVideo();
      if (this.atrack) await this.startAudio(this.atrack);
    }

    /** Sound for a running share, without choosing the screen again. */
    async addAudio(source) {
      const sup = support();
      let track;
      if (source && source.kind === 'device') {
        if (!sup.deviceAudio) throw new Error('Dieser Browser kann keinen Ton von einem Audiogerät übertragen.');
        let st;
        try {
          st = await navigator.mediaDevices.getUserMedia({ audio: {
            deviceId: source.deviceId ? { exact: source.deviceId } : undefined,
            echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 },
          } });
        } catch (e) { throw new Error(errorText(e)); }
        track = st.getAudioTracks()[0];
      } else {
        if (!sup.audio) throw new Error('Diesen Ton kann nur Chrome, Edge oder Opera (und die Desktop-App unter Windows) übertragen. Wähle stattdessen ein Audiogerät.');
        let st;
        try {
          st = await navigator.mediaDevices.getDisplayMedia({
            video: { displaySurface: 'monitor', width: { max: 320 }, height: { max: 240 }, frameRate: { max: 1 } },
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false, restrictOwnAudio: true },
            systemAudio: 'include', selfBrowserSurface: 'exclude',
          });
        } catch (e) { throw new Error(errorText(e)); }
        // Only the sound is needed: the picture stays the one already shared.
        for (const t of st.getVideoTracks()) t.stop();
        track = st.getAudioTracks()[0];
        if (!track) throw new Error('Es kam kein Ton. Hake im Auswahlfenster „Systemaudio teilen“ (ganzer Bildschirm) bzw. „Tab-Audio teilen“ (Tab) an. Einzelne Fenster haben in Chrome keinen Ton.');
      }
      if (!track) throw new Error('Kein Ton erhalten.');
      if (!this.running) { track.stop(); return; }
      await this.startAudio(track);
      this.audioOn = true;
      this.s.sendJson({ t: 'audio', on: true });
      this.sendConfig();
    }

    async pickCodec(w, h) {
      for (const codec of ['vp8', 'avc1.42E034', 'vp09.00.40.08']) {
        const cfg = this.encoderConfig(codec, w || 1920, h || 1080);
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r && r.supported) return codec;
        } catch { /* next */ }
      }
      return null;
    }

    bitrate(w, h) {
      const fps = this.fps > 30 ? 30 + (this.fps - 30) / 2 : Math.max(this.fps, 8);
      const want = w * h * fps * 0.07;
      const cap = this.s.maxKbps * 1000 * 0.85 - (this.audioOn ? 128000 : 0);
      return Math.round(Math.max(250000, Math.min(want, cap)));
    }

    encoderConfig(codec, w, h) {
      const cfg = { codec, width: w, height: h, bitrate: this.bitrate(w, h), framerate: this.fps, latencyMode: 'realtime' };
      if (codec.startsWith('avc')) cfg.avc = { format: 'annexb' };
      return cfg;
    }

    /** (Re)announce the stream, e.g. after reconnecting or changing the channel. */
    announce() {
      const st = this.vtrack ? this.vtrack.getSettings() : {};
      this.s.sendJson({ t: 'start', audio: !!this.audioOn, width: this.w || st.width || 0, height: this.h || st.height || 0 });
      if (this.cfgVideo) this.sendConfig();
      this.forceKey = true;
    }

    sendConfig() {
      this.s.sendJson({ t: 'config', width: this.w, height: this.h, video: this.cfgVideo, audio: this.cfgAudio });
    }

    startVideo() {
      if (window.MediaStreamTrackProcessor) {
        let reader;
        try { reader = new MediaStreamTrackProcessor({ track: this.vtrack, maxBufferSize: 2 }).readable.getReader(); } catch { reader = null; }
        if (reader) {
          this.reader = reader;
          (async () => {
            for (;;) {
              let r;
              try { r = await reader.read(); } catch { break; }
              if (r.done) break;
              this.onFrame(r.value);
            }
          })();
          return;
        }
      }
      // Firefox, Safari, WebKit: copy frames from a <video> element on a clock.
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = new MediaStream([this.vtrack]);
      v.play().catch(() => {});
      this.video = v;
      const grab = () => {
        if (!this.running || v.readyState < 2 || !v.videoWidth) return;
        let f;
        try { f = new VideoFrame(v, { timestamp: Math.round(performance.now() * 1000) }); } catch { return; }
        this.onFrame(f);
      };
      const ms = Math.max(10, Math.round(1000 / this.fps));
      try {
        this.tick = new Worker('share-tick.js');
        this.tick.onmessage = grab;
        this.tick.postMessage({ ms });
      } catch {
        this.tickTimer = setInterval(grab, ms);
      }
    }

    onFrame(frame) {
      const now = performance.now();
      if (!this.running || now - this.lastAt < 1000 / this.fps - 4) { frame.close(); return; }
      if (this.s.buffered() > MAX_BUFFERED || (this.enc && this.enc.encodeQueueSize > 2)) { frame.close(); return; }
      const q = QUALITIES[this.quality];
      let w = frame.displayWidth, h = frame.displayHeight;
      const scale = Math.min(1, q.w / w, q.h / h);
      const needEven = this.codec.startsWith('avc');
      let tw = Math.round(w * scale), th = Math.round(h * scale);
      if (needEven) { tw = even(tw); th = even(th); }
      let src = frame;
      if (tw !== w || th !== h) {
        src = this.scale(frame, tw, th);
        frame.close();
        if (!src) return;
      }
      w = tw; h = th;
      if (!this.enc || w !== this.w || h !== this.h) {
        if (!this.configure(w, h)) { src.close(); return; }
      }
      const key = this.forceKey || now - this.lastKey > KEY_INTERVAL;
      try {
        this.enc.encode(src, { keyFrame: key });
        if (key) { this.forceKey = false; this.lastKey = now; }
        this.lastAt = now;
      } catch (e) {
        console.warn('VideoEncoder', e);
        this.enc = null;
      }
      src.close();
    }

    /** Smaller copy of a frame (screen larger than the chosen quality). */
    scale(frame, w, h) {
      if (!this.canvas) {
        this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : el('canvas');
        this.ctx2d = this.canvas.getContext('2d', { alpha: false });
      }
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      try {
        this.ctx2d.drawImage(frame, 0, 0, w, h);
        return new VideoFrame(this.canvas, { timestamp: frame.timestamp });
      } catch { return null; }
    }

    configure(w, h) {
      if (this.enc) { try { this.enc.close(); } catch { /* ignore */ } }
      this.enc = null;
      const enc = new VideoEncoder({
        output: (chunk, meta) => this.onChunk(enc, chunk, meta),
        error: (e) => { console.warn('VideoEncoder', e); if (this.enc === enc) this.enc = null; },
      });
      try { enc.configure(this.encoderConfig(this.codec, w, h)); } catch (e) { console.warn('VideoEncoder', e); return false; }
      this.enc = enc;
      this.w = w;
      this.h = h;
      this.forceKey = true;
      this.cfgVideo = { codec: this.codec };
      this.sendConfig();
      return true;
    }

    onChunk(enc, chunk, meta) {
      if (enc !== this.enc) return;
      const d = meta && meta.decoderConfig;
      if (d) {
        const v = { codec: d.codec || this.codec };
        if (d.description) v.description = toB64(d.description);
        if (JSON.stringify(v) !== JSON.stringify(this.cfgVideo)) { this.cfgVideo = v; this.sendConfig(); }
      }
      if (!this.s.sendMedia(chunk.type === 'key' ? KIND_KEY : KIND_DELTA, chunk.timestamp, chunk) && chunk.type === 'key') this.forceKey = true;
    }

    /** Encode the sound of `track` (replaces an earlier sound source). */
    async startAudio(track) {
      this.stopAudio();
      this.atrack = track;
      this.aencFailed = false;
      track.addEventListener('ended', () => {
        if (this.atrack !== track) return;
        this.stopAudio();
        this.audioOn = false;
        this.s.sendJson({ t: 'audio', on: false });
        if (this.s.sender === this) this.s.emit('sending', this.info());
      });
      const feed = (d) => {
        if (this.running && this.audioOn && this.atrack === track && this.s.buffered() < MAX_BUFFERED) this.encodeAudio(d);
        d.close();
      };
      if (window.MediaStreamTrackProcessor) {
        let reader;
        try { reader = new MediaStreamTrackProcessor({ track }).readable.getReader(); } catch { reader = null; }
        if (reader) {
          this.areader = reader;
          (async () => {
            for (;;) {
              let r;
              try { r = await reader.read(); } catch { break; }
              if (r.done) break;
              feed(r.value);
            }
          })();
          return;
        }
      }
      // Firefox, Safari: an AudioWorklet hands over 20 ms blocks.
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || !window.AudioWorkletNode || !window.AudioData) throw new Error('Dieser Browser kann keinen Ton übertragen.');
      // 48 kHz suits Opus best; Firefox only connects a device at its own rate, then the default.
      let ctx, src;
      for (const opts of [{ sampleRate: 48000 }, {}]) {
        try {
          ctx = new Ctx(opts);
          src = ctx.createMediaStreamSource(new MediaStream([track]));
          break;
        } catch {
          if (ctx) { try { ctx.close(); } catch { /* ignore */ } }
          ctx = null;
        }
      }
      if (!ctx) throw new Error('Der Ton kann in diesem Browser nicht aufgenommen werden.');
      this.actx = ctx;
      await ctx.audioWorklet.addModule('share-audio.js');
      if (this.actx !== ctx) return;
      const node = new AudioWorkletNode(ctx, 'share-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(node).connect(mute).connect(ctx.destination);
      let ts = 0;
      node.port.onmessage = (e) => {
        const { ch, frames, data } = e.data;
        let d;
        try { d = new AudioData({ format: 'f32-planar', sampleRate: ctx.sampleRate, numberOfFrames: frames, numberOfChannels: ch, timestamp: ts, data }); } catch { return; }
        ts += Math.round(frames / ctx.sampleRate * 1e6);
        feed(d);
      };
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }

    stopAudio() {
      try { this.areader && this.areader.cancel(); } catch { /* ignore */ }
      this.areader = null;
      if (this.actx) { try { this.actx.close(); } catch { /* ignore */ } }
      this.actx = null;
      if (this.aenc) { try { this.aenc.close(); } catch { /* ignore */ } }
      this.aenc = null;
      if (this.atrack && !(this.stream && this.stream.getAudioTracks().includes(this.atrack))) this.atrack.stop();
    }

    encodeAudio(d) {
      if (this.aencFailed) return;
      // another source with another format: new encoder
      if (this.aenc && this.aencFmt && (this.aencFmt.sampleRate !== d.sampleRate || this.aencFmt.ch !== Math.min(2, d.numberOfChannels))) {
        try { this.aenc.close(); } catch { /* ignore */ }
        this.aenc = null;
      }
      if (!this.aenc) {
        const cfg = { codec: 'opus', sampleRate: d.sampleRate, numberOfChannels: Math.min(2, d.numberOfChannels), bitrate: 128000 };
        const enc = new AudioEncoder({
          output: (chunk, meta) => {
            const m = meta && meta.decoderConfig;
            if (m) {
              const a = { codec: 'opus', sampleRate: m.sampleRate || cfg.sampleRate, numberOfChannels: m.numberOfChannels || cfg.numberOfChannels };
              if (m.description) a.description = toB64(m.description);
              if (JSON.stringify(a) !== JSON.stringify(this.cfgAudio)) { this.cfgAudio = a; this.sendConfig(); }
            }
            this.s.sendMedia(KIND_AUDIO, chunk.timestamp, chunk);
          },
          error: (e) => { console.warn('AudioEncoder', e); if (this.aenc === enc) this.aenc = null; },
        });
        try { enc.configure(cfg); } catch (e) { console.warn('AudioEncoder', e); this.aencFailed = true; return; }
        this.aenc = enc;
        this.aencFmt = { sampleRate: d.sampleRate, ch: cfg.numberOfChannels };
        this.cfgAudio = { codec: 'opus', sampleRate: cfg.sampleRate, numberOfChannels: cfg.numberOfChannels };
        this.sendConfig();
      }
      if (d.numberOfChannels > 2) return;
      try { this.aenc.encode(d); } catch (e) { console.warn('AudioEncoder', e); }
    }

    setAudio(on) {
      if (on && (!this.atrack || this.atrack.readyState === 'ended')) return false;
      this.audioOn = !!on;
      this.s.sendJson({ t: 'audio', on: this.audioOn });
      return true;
    }

    requestKey() {
      const now = performance.now();
      if (now - (this.lastKeyReq || 0) < 300) return;
      this.lastKeyReq = now;
      this.forceKey = true;
    }

    info() {
      return {
        viewers: this.viewers, audio: !!this.audioOn, hasAudio: !!(this.atrack && this.atrack.readyState !== 'ended'), width: this.w, height: this.h,
        codec: this.codec, fps: this.fps, quality: this.quality, label: this.vtrack ? this.vtrack.label : '',
      };
    }

    stop() {
      this.running = false;
      try { this.reader && this.reader.cancel(); } catch { /* ignore */ }
      this.stopAudio();
      if (this.tick) this.tick.terminate();
      clearInterval(this.tickTimer);
      if (this.video) { this.video.srcObject = null; this.video = null; }
      if (this.stream) for (const t of this.stream.getTracks()) t.stop();
      if (this.enc) { try { this.enc.close(); } catch { /* ignore */ } }
      this.enc = null;
    }
  }
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

  // ------------------------------------------------------------------ viewer
  class Viewer {
    constructor(session, stream) {
      this.s = session;
      this.id = stream.id;
      this.info = stream;
      this.waitKey = true;
      this.vkey = '';
      this.akey = '';
      this.volume = store.get('vol.' + keyOf(stream), 1);
      this.muted = false;
      this.build();
      this.update(stream);
    }

    build() {
      this.canvas = el('canvas', { class: 'screen-canvas' });
      this.ctx2d = this.canvas.getContext('2d', { alpha: false });
      this.msgEl = el('div', { class: 'screen-msg' }, 'Warte auf das Bild…');
      this.nameEl = el('span', { class: 'screen-name' });
      this.sizeEl = el('span', { class: 'screen-size' });
      this.muteBtn = el('button', { type: 'button', class: 'screen-btn', title: 'Ton aus', onclick: () => this.setMuted(!this.muted) });
      this.volEl = el('input', { type: 'range', min: 0, max: 200, step: 5, value: Math.round(this.volume * 100), class: 'screen-vol', title: 'Lautstärke' });
      this.volEl.addEventListener('input', () => { this.volume = this.volEl.value / 100; store.set('vol.' + keyOf(this.info), this.volume); if (this.muted && this.volume > 0) this.setMuted(false); this.applyVolume(); });
      this.audioEl = el('span', { class: 'screen-audio' }, this.muteBtn, this.volEl);
      const full = el('button', { type: 'button', class: 'screen-btn', title: 'Vollbild', html: ICON.full, onclick: () => this.fullscreen() });
      const close = el('button', { type: 'button', class: 'screen-btn', title: 'Schließen', html: ICON.close, onclick: () => this.s.unwatch(this.id) });
      this.head = el('div', { class: 'screen-head' }, el('span', { class: 'screen-ico', html: ICON.screen }), this.nameEl, this.sizeEl, el('span', { class: 'grow' }), this.audioEl, full, close);
      this.body = el('div', { class: 'screen-body' }, this.canvas, this.msgEl);
      this.body.addEventListener('dblclick', () => this.fullscreen());
      this.el = el('div', { class: 'screen-tile', 'data-stream': this.id }, this.head, this.body);
      // a click may be needed before the browser plays sound
      this.el.addEventListener('click', () => { const o = this.s.audioOut(); if (o && o.ctx.state === 'suspended') o.ctx.resume().catch(() => {}); });
      this.renderMute();
    }

    update(s) {
      this.info = s;
      this.nameEl.textContent = s.name || 'Unbekannt';
      const size = s.width && s.height ? `${s.width}×${s.height}` : '';
      this.sizeEl.textContent = size;
      this.audioEl.hidden = !s.audio;
      this.head.title = `${s.name}${size ? ' · ' + size : ''}${s.audio ? ' · mit Ton' : ''}`;
    }

    message(text) { this.msgEl.textContent = text; this.msgEl.hidden = !text; }

    fullscreen() {
      if (document.fullscreenElement === this.el) { document.exitFullscreen().catch(() => {}); return; }
      const f = this.el.requestFullscreen || this.el.webkitRequestFullscreen;
      if (f) Promise.resolve(f.call(this.el)).catch(() => {});
    }

    configure(m) {
      const v = m.video || null;
      const vk = JSON.stringify(v);
      if (v && vk !== this.vkey) {
        this.vkey = vk;
        this.vcfg = { codec: v.codec, optimizeForLatency: true };
        if (v.description) this.vcfg.description = fromB64(v.description);
        this.resetVideo();
      }
      const a = m.audio || null;
      const ak = JSON.stringify(a);
      if (a && ak !== this.akey) {
        this.akey = ak;
        this.acfg = { codec: a.codec || 'opus', sampleRate: a.sampleRate || 48000, numberOfChannels: a.numberOfChannels || 2 };
        if (a.description) this.acfg.description = fromB64(a.description);
        this.resetAudio();
      }
    }

    async resetVideo() {
      if (this.dec) { try { this.dec.close(); } catch { /* ignore */ } }
      this.dec = null;
      this.waitKey = true;
      if (!window.VideoDecoder) { this.message('Dein Browser kann das Bild nicht anzeigen. Probiere Chrome, Edge, Firefox oder Safari.'); return; }
      const cfg = this.vcfg;
      try {
        const r = await VideoDecoder.isConfigSupported(cfg);
        if (!r || !r.supported) {
          this.message(`Dein Browser kann dieses Videoformat (${cfg.codec}) nicht anzeigen. Probiere Chrome, Edge oder Firefox.`);
          return;
        }
      } catch { /* try anyway */ }
      if (cfg !== this.vcfg || this.ended) return;
      const dec = new VideoDecoder({
        output: (f) => this.draw(f),
        error: (e) => {
          console.warn('VideoDecoder', e);
          if (this.dec === dec) { this.dec = null; this.broken = true; this.askKey(); }
        },
      });
      try { dec.configure(cfg); } catch (e) { console.warn('VideoDecoder', e); this.message('Das Bild kann nicht angezeigt werden.'); return; }
      this.dec = dec;
      this.askKey();
    }

    askKey() {
      const now = performance.now();
      if (now - (this.lastAsk || 0) < 500) return;
      this.lastAsk = now;
      this.s.sendJson({ t: 'keyframe', stream: this.id });
    }

    media(kind, ts, data) {
      if (kind === KIND_AUDIO) { this.audio(ts, data); return; }
      if (!this.dec) {
        if (this.broken && this.vcfg) { this.broken = false; this.resetVideo(); }
        return;
      }
      if (this.waitKey && kind !== KIND_KEY) return;
      if (this.dec.decodeQueueSize > 8) { this.waitKey = true; this.askKey(); return; }
      try {
        this.dec.decode(new EncodedVideoChunk({ type: kind === KIND_KEY ? 'key' : 'delta', timestamp: ts, data }));
        this.waitKey = false;
      } catch (e) {
        console.warn('VideoDecoder', e);
        this.waitKey = true;
        this.askKey();
      }
    }

    draw(f) {
      if (this.ended) { f.close(); return; }
      const w = f.displayWidth, h = f.displayHeight;
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      try { this.ctx2d.drawImage(f, 0, 0, w, h); } catch { /* ignore */ }
      f.close();
      if (!this.gotFrame) { this.gotFrame = true; this.message(''); }
    }

    resetAudio() {
      if (this.adec) { try { this.adec.close(); } catch { /* ignore */ } }
      this.adec = null;
      if (!window.AudioDecoder || !this.acfg) return;
      const dec = new AudioDecoder({
        output: (d) => this.play(d),
        error: (e) => { console.warn('AudioDecoder', e); if (this.adec === dec) this.adec = null; },
      });
      try { dec.configure(this.acfg); } catch (e) { console.warn('AudioDecoder', e); return; }
      this.adec = dec;
    }

    audio(ts, data) {
      if (this.muted || !this.info.audio || (this.s.opts.audioMuted && this.s.opts.audioMuted())) return;
      if (!this.adec) { if (this.acfg && !this.audioRetried) { this.audioRetried = true; this.resetAudio(); } if (!this.adec) return; }
      try { this.adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data })); } catch { /* ignore */ }
    }

    play(d) {
      const out = this.ended ? null : this.s.audioOut();
      if (!out) { d.close(); return; }
      const ctx = out.ctx;
      if (!this.gain || this.gainCtx !== ctx) {
        if (this.gain) { try { this.gain.disconnect(); } catch { /* ignore */ } }
        this.gain = ctx.createGain();
        this.gain.connect(out.node);
        this.gainCtx = ctx;
        this.next = 0;
        this.applyVolume();
      }
      const n = d.numberOfFrames, ch = Math.min(2, d.numberOfChannels);
      let buf;
      try {
        buf = ctx.createBuffer(ch, n, d.sampleRate);
        for (let c = 0; c < ch; c++) {
          const arr = new Float32Array(n);
          d.copyTo(arr, { planeIndex: c, format: 'f32-planar' });
          buf.copyToChannel(arr, c);
        }
      } catch { d.close(); return; }
      d.close();
      const now = ctx.currentTime;
      if (!this.next || this.next < now + 0.01 || this.next > now + 0.6) this.next = now + AUDIO_LEAD;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      src.start(this.next);
      this.next += buf.duration;
    }

    applyVolume() { if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume; }

    setMuted(m) { this.muted = m; this.applyVolume(); this.renderMute(); }

    renderMute() {
      const off = this.muted || this.volume === 0;
      this.muteBtn.innerHTML = off ? ICON.speakerOff : ICON.speaker;
      this.muteBtn.title = off ? 'Ton an' : 'Ton aus';
      this.muteBtn.classList.toggle('off', off);
    }

    end(why) {
      this.ended = true;
      for (const d of [this.dec, this.adec]) { if (d) { try { d.close(); } catch { /* ignore */ } } }
      this.dec = null;
      this.adec = null;
      if (this.gain) { try { this.gain.disconnect(); } catch { /* ignore */ } }
      if (document.fullscreenElement === this.el) document.exitFullscreen().catch(() => {});
      this.el.remove();
      this.why = why || '';
    }
  }

  // ------------------------------------------------------------------ dialog helpers
  const PICK_ICON = {
    monitor: svg('<rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 20.5h8M12 16.5v4"/>'),
    window: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01M9 6.5h.01"/>'),
    browser: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 9V6.5A2.5 2.5 0 0 1 5.5 4H10l1.5 5"/>'),
    text: svg('<path d="M5 6h14M5 10h14M5 14h9M5 18h6"/>'),
    standard: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M10 9l4 2-4 2z"/>'),
    smooth: svg('<path d="M4 16c3-8 5-8 8 0s5 8 8 0"/>'),
    sound: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),
    device: svg('<rect x="7" y="3" width="10" height="18" rx="2"/><circle cx="12" cy="14" r="3"/><path d="M12 7h.01"/>'),
  };
  const PRESETS = {
    text: { label: 'Text & Folien', hint: 'Gestochen scharf, 5 Bilder/s, wenig Daten', quality: '1440', fps: 5 },
    standard: { label: 'Standard', hint: '1080p, 30 Bilder/s', quality: '1080', fps: 30 },
    smooth: { label: 'Flüssig', hint: 'Spiele & Videos, 60 Bilder/s', quality: '1080', fps: 60 },
  };

  /** A row of big radio cards. items: [value, icon, title, hint]. */
  function choices(name, items, value, onChange) {
    const box = el('div', { class: 'share-choices', role: 'radiogroup' });
    const sync = () => { for (const l of box.children) l.classList.toggle('checked', l.querySelector('input').checked); };
    for (const [v, icon, title, hint] of items) {
      const input = el('input', { type: 'radio', name, value: v });
      input.checked = v === value;
      input.addEventListener('change', () => { sync(); if (onChange) onChange(v); });
      box.append(el('label', { class: 'share-choice' }, input,
        el('span', { class: 'share-choice-ico', html: icon }),
        el('strong', {}, title),
        hint ? el('span', { class: 'share-choice-hint' }, hint) : null));
    }
    sync();
    return { node: box, value: () => (box.querySelector('input:checked') || {}).value };
  }

  /** Start dialog: what to share, quality, sound (used by app.js and screen.js). */
  function optionsForm(prefs = {}, { tabs = true } = {}) {
    const sup = support();
    const surfaces = [
      ['monitor', PICK_ICON.monitor, 'Ganzer Bildschirm', 'Alles, was du siehst'],
      ['window', PICK_ICON.window, 'Fenster', 'Ein Programm'],
    ];
    if (tabs && sup.tabs) surfaces.push(['browser', PICK_ICON.browser, 'Browser-Tab', 'Mit Ton des Tabs']);
    const surface = choices('share-surface', surfaces, surfaces.some((x) => x[0] === prefs.surface) ? prefs.surface : 'monitor');

    const quality = el('select', { id: 'share-quality' }, Object.entries(QUALITIES).map(([k, q]) => el('option', { value: k }, q.label)));
    const fps = el('select', { id: 'share-fps' }, FPS.map((f) => el('option', { value: f }, `${f} Bilder/s`)));
    const presetOf = (q, f) => Object.keys(PRESETS).find((k) => PRESETS[k].quality === q && PRESETS[k].fps === f) || '';
    const q0 = QUALITIES[prefs.quality] ? String(prefs.quality) : '1080';
    const f0 = FPS.includes(Number(prefs.fps)) ? Number(prefs.fps) : 30;
    quality.value = q0;
    fps.value = String(f0);
    const preset = choices('share-preset', Object.entries(PRESETS).map(([k, p]) => [k, PICK_ICON[k], p.label, p.hint]), presetOf(q0, f0), (k) => {
      quality.value = PRESETS[k].quality;
      fps.value = String(PRESETS[k].fps);
    });
    const fine = () => {
      const k = presetOf(quality.value, Number(fps.value));
      for (const input of preset.node.querySelectorAll('input')) input.checked = input.value === k;
      for (const l of preset.node.children) l.classList.toggle('checked', l.querySelector('input').checked);
    };
    quality.addEventListener('change', fine);
    fps.addEventListener('change', fine);

    const audio = el('input', { type: 'checkbox', id: 'share-audio', class: 'switch' });
    audio.checked = prefs.audio !== false && (sup.audio || sup.deviceAudio);
    audio.disabled = !sup.audio && !sup.deviceAudio;
    const audioHint = sup.audio
      ? 'Wähle im nächsten Fenster „Systemaudio teilen“ bzw. „Tab-Audio teilen“. Du kannst den Ton auch später jederzeit einschalten.'
      : sup.deviceAudio
        ? 'Dieser Browser schickt den Ton des Bildschirms nicht mit. Du kannst während der Übertragung ein Audiogerät (z. B. Stereomix) als Ton wählen.'
        : 'In diesem Browser nicht möglich.';

    const node = el('div', { class: 'share-form' },
      el('div', { class: 'share-section' }, el('div', { class: 'share-label' }, 'Was möchtest du teilen?'), surface.node),
      el('div', { class: 'share-section' }, el('div', { class: 'share-label' }, 'Qualität'), preset.node,
        el('details', { class: 'share-fine' }, el('summary', {}, 'Feineinstellung'),
          el('div', { class: 'share-fine-row' }, el('label', {}, 'Auflösung', quality), el('label', {}, 'Bildrate', fps)))),
      el('label', { class: 'share-toggle' + (audio.disabled ? ' disabled' : '') },
        el('span', { class: 'share-choice-ico', html: PICK_ICON.sound }),
        el('span', { class: 'share-toggle-text' }, el('strong', {}, 'Ton übertragen'), el('span', { class: 'share-choice-hint' }, audioHint)),
        audio),
      el('p', { class: 'share-note' }, 'Danach öffnet der Browser sein eigenes Auswahlfenster. Fehlt dort ein Fenster? Minimierte Fenster und Fenster auf anderen virtuellen Desktops zeigt er meist nicht – Fenster vorher wiederherstellen oder „Ganzer Bildschirm“ wählen.'));
    return {
      node,
      values: () => ({ surface: surface.value(), quality: quality.value, fps: Number(fps.value), audio: audio.checked && sup.audio }),
      wantsAudio: () => audio.checked,
    };
  }

  /** "Ton hinzufügen" during a share: sound of the system/tab or an audio device. */
  function audioForm() {
    const sup = support();
    const items = [];
    if (sup.audio) items.push(['display', PICK_ICON.sound, 'System- oder Tab-Ton', 'Der Browser fragt noch einmal – dein Bild bleibt, wie es ist']);
    if (sup.deviceAudio) items.push(['device', PICK_ICON.device, 'Audiogerät', 'z. B. Stereomix, VB-Cable oder ein Mikrofon']);
    if (!items.length) {
      return { node: el('p', {}, 'Dieser Browser kann keinen Ton übertragen. Nimm Chrome, Edge oder Opera.'), values: () => null };
    }
    const devSel = el('select', { id: 'share-audio-device' }, el('option', { value: '' }, 'Standard-Eingabegerät'));
    const devRow = el('label', { class: 'share-device' }, 'Gerät', devSel);
    const pick = choices('share-audio-src', items, items[0][0], (v) => { devRow.hidden = v !== 'device'; });
    devRow.hidden = pick.value() !== 'device';
    if (sup.deviceAudio && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then((devs) => {
        const ins = devs.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
        const named = ins.map((d, i) => ({ id: d.deviceId, label: d.label || `Eingang ${i + 1}` }));
        // stereo mix / virtual cables first: what people usually want here
        named.sort((a, b) => (/stereo|mix|cable|loopback|monitor|blackhole/i.test(b.label) ? 1 : 0) - (/stereo|mix|cable|loopback|monitor|blackhole/i.test(a.label) ? 1 : 0));
        for (const d of named) devSel.append(el('option', { value: d.id }, d.label));
        const best = named.find((d) => /stereo|mix|cable|loopback|monitor|blackhole/i.test(d.label));
        if (best) devSel.value = best.id;
      }).catch(() => {});
    }
    const node = el('div', { class: 'share-form' },
      el('p', { class: 'muted small' }, 'Deine Übertragung läuft dabei weiter. Deine Stimme aus dem Sprachchat wird nicht mitgeschickt.'),
      pick.node, devRow,
      sup.audio ? el('p', { class: 'share-note' }, 'System-Ton: Wähle im Auswahlfenster „Ganzer Bildschirm“ und hake „Systemaudio teilen“ an – oder einen Tab mit „Tab-Audio teilen“. Einzelne Fenster haben dort keinen Ton.') : null);
    return { node, values: () => (pick.value() === 'device' ? { kind: 'device', deviceId: devSel.value } : { kind: 'display' }) };
  }

  window.FunkShare = { Session, support, server, here, link, openExternal, optionsForm, audioForm, ICON, QUALITIES };
})();
