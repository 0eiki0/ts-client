'use strict';
/* Funkraum – user interface (from Funkraum Web). */

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('tsweb.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tsweb.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem('tsweb.' + k); } catch { /* ignore */ } },
};
const fmtTime = (d = new Date()) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDuration = (s) => {
  if (s == null) return '–';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`;
};
const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (l) => (l <= 0.00001 ? -100 : 20 * Math.log10(l));

// Inline SVG icons (stroke style)
const svg = (path, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${path}</svg>`;
const ICON = {
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  micOff: svg('<path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v3"/>'),
  speaker: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),
  speakerOff: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>'),
  away: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  power: svg('<path d="M12 3v9M6.3 7.3a8 8 0 1 0 11.4 0"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  channel: svg('<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  mini: svg('<rect x="3" y="4" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none"/>'),
  expand: svg('<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.01"/>'),
  warn: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>'),
  shield: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  server: svg('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
};

// ---------------------------------------------------------------- settings
/** Actions that can have a key; `hold` = active while the key is held down. */
const KEY_ACTIONS = [
  ['ptt', 'Push-to-Talk (gedrückt halten)', true],
  ['mic', 'Mikrofon stumm / an', false],
  ['speaker', 'Lautsprecher stumm / an', false],
  ['away', 'Abwesend / wieder da', false],
  ['help', 'Hilfe öffnen', false],
];
const DEFAULT_KEYS = () => ({ ptt: { code: 'Space' }, mic: { code: 'KeyM' }, speaker: { code: 'KeyL' }, away: null, help: { code: 'F1' } });
const DEFAULTS = {
  mode: 'auto', vadDb: -45, gain: 100, autoLevel: true, lightFilter: false,
  echo: true, noise: true, denoise: true, agc: true, volume: 100, soundMode: 'voice', soundVolume: 80, soundOff: [], showQuery: false, notify: false,
  joinLeave: true, history: true, theme: 'auto', inputDevice: '', outputDevice: '', outputLabel: '',
};
const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
if (settings.sounds === false && !('soundMode' in store.get('settings', {}))) settings.soundMode = 'off'; // older versions
delete settings.sounds;
if (!('speechSynthesis' in window) && settings.soundMode === 'voice') settings.soundMode = 'tones';
// key bindings (older versions only had a push-to-talk key)
settings.keys = Object.assign({}, DEFAULT_KEYS(), settings.keys || {});
if (settings.pttKey) { settings.keys.ptt = { code: settings.pttKey }; delete settings.pttKey; delete settings.pttKeyLabel; }
// v2: automatic voice activation and filter chain are the new default
if (!settings.v || settings.v < 2) {
  if (settings.mode === 'vad') settings.mode = 'auto';
  settings.denoise = true;
  settings.v = 2;
  try { store.set('settings', settings); } catch { /* ignore */ }
}
const saveSettings = () => store.set('settings', settings);
function applyTheme() {
  if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
}
applyTheme();

// ---------------------------------------------------------------- state
const S = {
  config: null,
  ws: null,
  connParams: null,
  status: 'disconnected',
  userDisconnect: false,
  reconnectTries: 0,
  ownId: null,
  server: null,
  channels: new Map(),
  clients: new Map(),
  talking: new Set(),
  canTalk: true,
  inputMuted: false,
  outputMuted: false,
  away: false,
  selected: null, // {type, id}
  welcomeShown: false,
  sentVolumes: new Map(),
  // chat
  tabs: new Map(), // key -> {title, msgs:[], unread, closable, clientId}
  activeTab: 'channel', // the chat of the channel you are in
  // audio
  ctx: null,
  captureNode: null,
  playbackNode: null,
  outGain: null,
  micStream: null,
  micSource: null,
  transmitting: false,
  pttDown: false,
  vadHang: 0,
  lastRms: 0,
  preroll: [],
  identity: null,
};

// ---------------------------------------------------------------- sounds
// Notification sounds like in the TeamSpeak 3 client: spoken announcements (speech
// synthesis of the browser/OS, German voice), simple tones, or own sound files
// per event (stored in this browser, IndexedDB).
const SOUND_EVENTS = [
  // id, label in the settings, spoken text, tone
  ['connected', 'Verbunden', 'Verbunden', 'connect'],
  ['disconnected', 'Verbindung getrennt', 'Verbindung getrennt', 'disconnect'],
  ['lost', 'Verbindung verloren', 'Verbindung verloren', 'disconnect'],
  ['reconnected', 'Wieder verbunden', 'Wieder verbunden', 'connect'],
  ['kicked', 'Vom Server gekickt', 'Du wurdest vom Server gekickt', 'disconnect'],
  ['banned', 'Gebannt', 'Du wurdest gebannt', 'disconnect'],
  ['user_joined', 'Jemand betritt deinen Kanal', 'Benutzer hat deinen Kanal betreten', 'join'],
  ['user_left', 'Jemand verlässt deinen Kanal', 'Benutzer hat deinen Kanal verlassen', 'leave'],
  ['switched', 'Du wechselst den Kanal', 'Kanal gewechselt', 'join'],
  ['moved', 'Du wirst verschoben', 'Du wurdest verschoben', 'join'],
  ['channel_kick', 'Aus dem Kanal gekickt', 'Du wurdest aus dem Kanal gekickt', 'leave'],
  ['message', 'Nachricht (Server/Kanal)', 'Neue Nachricht', 'message'],
  ['pm', 'Private Nachricht', 'Private Nachricht', 'message'],
  ['poke', 'Anstupsen', 'Du wurdest angestupst', 'poke'],
  ['mic_off', 'Mikrofon stumm', 'Mikrofon stummgeschaltet', 'mute'],
  ['mic_on', 'Mikrofon an', 'Mikrofon aktiviert', 'unmute'],
  ['sound_off', 'Lautsprecher stumm', 'Lautsprecher stummgeschaltet', 'mute'],
  ['sound_on', 'Lautsprecher an', 'Lautsprecher aktiviert', 'unmute'],
  ['away', 'Abwesend', 'Abwesend', 'mute'],
  ['back', 'Wieder da', 'Wieder anwesend', 'unmute'],
];
const SOUND_BY_ID = new Map(SOUND_EVENTS.map((e) => [e[0], e]));

const TONES = {
  message: [[880, 0.07]], poke: [[660, 0.1], [990, 0.12]], join: [[520, 0.06], [780, 0.08]],
  leave: [[780, 0.06], [520, 0.08]], connect: [[440, 0.08], [660, 0.08], [880, 0.1]],
  disconnect: [[660, 0.08], [440, 0.12]], mute: [[300, 0.06]], unmute: [[600, 0.06]],
};

/** Audio context for notification sounds (the voice one if it exists). */
/** Where audio of this context goes: the selected output device, if any. */
function sinkOf(ctx) { return ctx === S.ctx && S.outBus ? S.outBus : ctx.destination; }

function fxCtx() {
  if (S.ctx) return S.ctx;
  if (!S.fxCtx) { const C = window.AudioContext || window.webkitAudioContext; S.fxCtx = new C(); }
  return S.fxCtx;
}

function playTone(kind, vol) {
  const tones = TONES[kind];
  if (!tones) return;
  const ctx = fxCtx();
  let t = ctx.currentTime + 0.01;
  for (const [f, d] of tones) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.2 * vol), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(sinkOf(ctx));
    o.start(t); o.stop(t + d + 0.02);
    t += d + 0.02;
  }
}

function germanVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices().filter((v) => /^de(-|_|$)/i.test(v.lang));
  if (!voices.length) return null;
  // Prefer female voices (like the TeamSpeak 3 default pack) and local ones (no delay).
  const score = (v) => (/(female|frau|anna|katja|hedda|petra|marlene|vicki|helena|google deutsch)/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
  return voices.sort((a, b) => score(b) - score(a))[0];
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { S.voice = germanVoice(); };

function speak(text, vol) {
  if (!('speechSynthesis' in window)) return false;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  S.voice = S.voice || germanVoice();
  if (S.voice) u.voice = S.voice;
  u.rate = 1.1;
  u.volume = Math.min(1, vol);
  speechSynthesis.cancel(); // the newest announcement wins, no long queue
  speechSynthesis.speak(u);
  return true;
}

// own sound files (IndexedDB: tsweb/sounds, key = event id, value = { name, blob })
function soundDb() {
  if (!S.soundDb) {
    S.soundDb = new Promise((resolve, reject) => {
      const r = indexedDB.open('tsweb', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('sounds');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return S.soundDb;
}
async function soundStore(mode, fn) {
  const db = await soundDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sounds', mode);
    const req = fn(tx.objectStore('sounds'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function loadCustomSounds() {
  S.customSounds = new Map();
  try {
    const keys = await soundStore('readonly', (st) => st.getAllKeys());
    for (const k of keys || []) S.customSounds.set(k, await soundStore('readonly', (st) => st.get(k)));
  } catch (e) { console.warn('Eigene Sounds nicht verfügbar', e); }
}
S.decoded = new Map();
async function playCustom(id, vol) {
  const entry = S.customSounds && S.customSounds.get(id);
  if (!entry) return false;
  const ctx = fxCtx();
  try {
    let buf = S.decoded.get(id);
    if (!buf) { buf = await ctx.decodeAudioData(await entry.blob.arrayBuffer()); S.decoded.set(id, buf); }
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf; g.gain.value = vol;
    src.connect(g).connect(sinkOf(ctx));
    src.start();
    return true;
  } catch (e) { console.warn('Sound konnte nicht abgespielt werden', id, e); return false; }
}

/** Play the notification for an event (respects mode, volume and per-event switches). */
function sound(id, { force = false } = {}) {
  const ev = SOUND_BY_ID.get(id);
  if (!ev) return;
  if (!force && (settings.soundMode === 'off' || settings.soundOff.includes(id))) return;
  // Sound switched off completely: no announcements either – only the
  // confirmation that it was just switched off.
  if (!force && S.outputMuted && id !== 'sound_off') return;
  const vol = settings.soundVolume / 100;
  const ctx = S.ctx || S.fxCtx;
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (S.customSounds && S.customSounds.has(id)) { playCustom(id, vol); return; }
  if (settings.soundMode === 'voice' && speak(ev[2], vol)) return;
  playTone(ev[3], vol);
}

function notify(title, body) {
  if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try { new Notification(title, { body, icon: 'icon.svg', tag: 'tsweb' }); } catch { /* ignore */ }
}

function toast(text, kind = '') {
  const t = el('div', { class: 'toast ' + kind }, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4500);
}

// ---------------------------------------------------------------- BBCode
function bbcode(text) {
  let s = esc(text);
  const safeUrl = (u) => {
    const raw = u.replace(/&amp;/g, '&');
    return /^(https?:\/\/|ts3server:\/\/)/i.test(raw) ? raw : null;
  };
  s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (m, u, t) => {
    const url = safeUrl(u);
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${t}</a>` : t;
  });
  s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (m, u) => {
    const url = safeUrl(u);
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${u}</a>` : u;
  });
  s = s.replace(/\[(b|i|u|s)\]([\s\S]*?)\[\/\1\]/gi, (m, tag, t) => `<${tag.toLowerCase()}>${t}</${tag.toLowerCase()}>`);
  s = s.replace(/\[color=(#[0-9a-f]{3,8}|[a-z]+)\]([\s\S]*?)\[\/color\]/gi, (m, c, t) => `<span style="color:${c}">${t}</span>`);
  s = s.replace(/\[size=[^\]]+\]([\s\S]*?)\[\/size\]/gi, '$1');
  s = s.replace(/\[(center|left|right)\]([\s\S]*?)\[\/\1\]/gi, (m, a, t) => `<div style="text-align:${a.toLowerCase()}">${t}</div>`);
  s = s.replace(/\[hr\]/gi, '<hr>');
  s = s.replace(/\[\/?(img|list|\*|table|tr|td|th|quote|code)\]/gi, '');
  // auto-link bare URLs that are not already inside a tag
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (m, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  return s.replace(/\n/g, '<br>');
}

// ---------------------------------------------------------------- login
async function init() {
  try {
    S.config = await (await fetch('api/config')).json();
  } catch {
    S.config = { title: 'Funkraum', server: '', allow_any_server: true, needs_access_password: false };
  }
  document.title = S.config.title;
  $('#app-title').textContent = S.config.title;
  $('#login-server-label').textContent = S.config.allow_any_server ? 'Sprachchat' : `Server: ${S.config.server}`;
  $('#row-address').hidden = !S.config.allow_any_server;
  $('#row-access').hidden = !S.config.needs_access_password;
  if (!window.isSecureContext) $('#insecure-warning').hidden = false;

  const saved = store.get('login', {});
  $('#f-nickname').value = saved.nickname || '';
  $('#f-address').value = saved.address || S.config.default_address || '';
  if (S.config.default_address) $('#f-address').placeholder = S.config.default_address;
  $('#f-channel').value = saved.channel || S.config.default_channel || '';
  $('#f-access').value = store.get('access', '') || '';
  migrateIdentities();
  loadCustomSounds();
  if (syncState()) syncNow().catch((e) => console.warn('Sync', e));
  renderIdentityRow();

  $('#login-form').addEventListener('submit', (e) => { e.preventDefault(); startLogin(); });
  $('#l-id-manage').addEventListener('click', () => identityManager());
  $('#f-identity').addEventListener('change', (e) => { setActiveIdentity(e.target.value); renderIdentityRow(); });
  $('#f-address').addEventListener('input', renderIdentityRow);
  const err = sessionStorage.getItem('tsweb.error');
  if (err) { showLoginError(err); sessionStorage.removeItem('tsweb.error'); }
  $('#f-nickname').focus();
  setupStaticUI();
}

function serverKey() {
  return (S.config.allow_any_server ? ($('#f-address').value.trim() || S.config.server) : S.config.server) || 'default';
}
// ---------------------------------------------------------------- identities
// Several identities can be stored in this browser (like in the TeamSpeak 3 client).
// store 'ids': [{ id, name, identity, uid, level }]
// store 'idActive': { <serverKey>: id, _default: id } – which one is used where.
function idList() { return store.get('ids', []); }
function saveIdList(list) {
  store.set('ids', list);
  if (!S.syncing) scheduleSync();
}
function idCounter(identity) { return parseInt(String(identity).split('V')[0], 10) || 0; }

/** Older versions kept one identity per server under 'identity.<server>'. */
function migrateIdentities() {
  if (store.get('ids', null) !== null) return;
  const list = [], active = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('tsweb.identity.')) continue;
      const server = k.slice('tsweb.identity.'.length);
      const v = store.get('identity.' + server, null);
      if (!v || !v.identity) continue;
      let e = list.find((x) => x.identity === v.identity || (v.uid && x.uid === v.uid));
      if (!e) {
        e = { id: newId(), name: list.length ? `Identität (${server})` : 'Meine Identität', identity: v.identity, uid: v.uid || '' };
        list.push(e);
      }
      active[server] = e.id;
      active._default = active._default || e.id;
    }
  } catch { /* storage not available */ }
  saveIdList(list);
  store.set('idActive', active);
  for (const k of Object.keys(active)) if (k !== '_default') store.del('identity.' + k);
}

function newId() { return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2); }

/** The identity that is used for the server in the login form. */
function activeIdentity() {
  const list = idList();
  const map = store.get('idActive', {});
  return list.find((x) => x.id === map[serverKey()]) || list.find((x) => x.id === map._default) || list[0] || null;
}
function setActiveIdentity(id) {
  const map = store.get('idActive', {});
  map[serverKey()] = id;
  map._default = id;
  store.set('idActive', map);
}

/** Add an identity (or update the stored one with the same unique id). */
function addIdentity(data, name) {
  const list = idList();
  let e = list.find((x) => x.uid && x.uid === data.uid);
  if (e) {
    // same key: keep the higher security level (bigger counter)
    if (idCounter(data.identity) > idCounter(e.identity)) { e.identity = data.identity; e.updated = Date.now(); }
    if (data.level != null) e.level = Math.max(e.level || 0, data.level);
  } else {
    e = { id: newId(), name: (name || '').trim() || `Identität ${list.length + 1}`, identity: data.identity, uid: data.uid, level: data.level, updated: Date.now() };
    list.push(e);
  }
  saveIdList(list);
  return e;
}

function renderIdentityRow() {
  const list = idList();
  const sel = $('#f-identity');
  const act = activeIdentity();
  sel.textContent = '';
  for (const e of list) sel.append(el('option', { value: e.id, selected: act && act.id === e.id }, e.name));
  $('#row-identity').hidden = !list.length;
  const st = syncState();
  $('#identity-hint').textContent = list.length
    ? (act ? `Eindeutige ID: ${act.uid || '(wird beim Verbinden berechnet)'}` : '') + (st ? ` · ☁ Sync: ${st.name}` : '')
    : 'Noch keine Identität – beim ersten Verbinden wird eine neue erzeugt, oder du importierst eine bestehende.';
}
const updateIdentityHint = renderIdentityRow;

// ---------------------------------------------------------------- identity import/export
function accessKey() {
  return (S.config.needs_access_password ? (S.access || $('#f-access').value || store.get('access', '')) : '') || '';
}

async function identityApi(path, body) {
  const q = S.config.needs_access_password ? '?key=' + encodeURIComponent(accessKey()) : '';
  const res = await fetch(path + q, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body || '' });
  if (res.status === 401) throw new Error('Falsches Zugangspasswort – bitte zuerst im Anmeldeformular eintragen.');
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error((data && data.error) || `Fehler ${res.status}`);
  return data;
}

/** Name from a TeamSpeak 3 client export (`id=…` in the .ini). */
function nameFromIni(text) {
  const m = text.match(/^\s*id\s*=\s*"?([^"\r\n]+)"?\s*$/mi);
  return m ? m[1].trim() : '';
}

function identityImport(back) {
  const ta = el('textarea', { rows: 6, placeholder: 'identity="123V…"', spellcheck: 'false' });
  const name = el('input', { placeholder: 'z. B. Haupt-Identität' });
  const file = el('input', { type: 'file', accept: '.ini,.txt,text/plain' });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    ta.value = await f.text();
    if (!name.value) name.value = nameFromIni(ta.value);
  });
  ta.addEventListener('input', () => { if (!name.value) name.value = nameFromIni(ta.value); });
  const err = el('div', { class: 'alert error', hidden: true });
  const body = el('div', { class: 'id-import' },
    el('p', { class: 'small muted' }, 'TeamSpeak 3: Extras → Identitäten → Identität auswählen → Exportieren (im TeamSpeak-6-Programm findest du den Export in den Einstellungen bei den Identitäten, falls vorhanden). Wähle die exportierte .ini-Datei aus oder füge ihren Inhalt (bzw. den Wert „identity=…“) ein.'),
    el('div', { class: 'file-row' }, file),
    ta,
    el('label', {}, 'Name (nur zur Anzeige)', name),
    err,
    el('p', { class: 'small muted' }, 'Die Identität wird zusätzlich zu deinen vorhandenen gespeichert – es geht nichts verloren. Behandle sie wie ein Passwort.'));
  const ok = el('button', { class: 'primary' }, 'Importieren');
  ok.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) { err.textContent = 'Bitte eine Identität einfügen oder eine Datei auswählen.'; err.hidden = false; return; }
    ok.disabled = true;
    try {
      const data = await identityApi('api/identity', text);
      const known = idList().some((x) => x.uid === data.uid);
      const e = addIdentity(data, name.value);
      setActiveIdentity(e.id);
      renderIdentityRow();
      toast(known ? `„${e.name}“ war schon vorhanden und ist jetzt ausgewählt` : `„${e.name}“ importiert und ausgewählt (Sicherheitslevel ${data.level})`);
      identityManager();
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    } finally { ok.disabled = false; }
  });
  openModal('Identität importieren', body, [el('button', { onclick: () => (back ? back() : closeModal()) }, 'Zurück'), ok]);
}

function identityExport(e, back) {
  if (!e) return toast('Noch keine Identität vorhanden');
  const ta = el('textarea', { rows: 5, readonly: true });
  ta.value = e.identity;
  const copy = el('button', { class: 'primary', onclick: () => { navigator.clipboard?.writeText(e.identity); toast('Kopiert'); } }, 'Kopieren');
  const download = el('button', { onclick: () => {
    // one line per value: no line breaks or quotes from names can add own entries
    const line = (v) => String(v).replace(/[\r\n"\\]/g, ' ').trim();
    const ini = `[Identity]\nid=${line(e.name)}\nidentity="${line(e.identity)}"\nnickname=${line($('#f-nickname').value.trim() || e.name)}\n`;
    const a = el('a', { href: URL.createObjectURL(new Blob([ini], { type: 'text/plain' })), download: `${e.name.replace(/[^\w.-]+/g, '_') || 'identity'}.ini` });
    document.body.append(a); a.click(); a.remove();
  } }, 'Als .ini speichern');
  openModal(`Identität „${e.name}“ exportieren`, el('div', {},
    el('p', { class: 'small muted' }, `Eindeutige ID: ${e.uid}`),
    el('p', { class: 'small muted' }, 'Behandle diesen Schlüssel wie ein Passwort. Damit kann sich jeder als du ausgeben. Die .ini-Datei kann im TeamSpeak-3-Programm unter Extras → Identitäten importiert werden.'),
    ta), [el('button', { onclick: () => (back ? back() : closeModal()) }, 'Zurück'), download, copy]);
}

/** List of all identities: choose, rename, export, delete, import, create. */
function identityManager() {
  const body = el('div', { class: 'id-manager' });
  const render = () => {
    body.textContent = '';
    const card = syncCard(render);
    if (card) body.append(card);
    const list = idList();
    const act = activeIdentity();
    if (!list.length) body.append(el('p', { class: 'muted small' }, 'Noch keine Identität gespeichert. Importiere eine bestehende oder erstelle eine neue. Ohne Identität wird beim Verbinden automatisch eine erzeugt.'));
    for (const e of list) {
      const isAct = act && act.id === e.id;
      const nameEl = el('strong', { class: 'id-name' }, e.name);
      const actions = el('div', { class: 'id-actions' },
        isAct ? null : el('button', { class: 'primary', onclick: () => { setActiveIdentity(e.id); renderIdentityRow(); render(); } }, 'Verwenden'),
        el('button', { onclick: () => rename(e, nameEl) }, 'Umbenennen'),
        el('button', { onclick: () => identityExport(e, identityManager) }, 'Exportieren'),
        el('button', { class: 'danger', onclick: () => remove(e) }, 'Löschen'));
      body.append(el('div', { class: 'id-card' + (isAct ? ' active' : '') },
        el('div', { class: 'id-head' }, el('span', { class: 'talk-dot avatar', style: `--hue:${nameHue(e.uid || e.name)}` }, initial(e.name)),
          el('div', { class: 'id-meta' }, el('div', {}, nameEl, isAct ? el('span', { class: 'id-badge' }, 'Aktiv') : null),
            el('code', { class: 'id-uid' }, e.uid || '(wird beim Verbinden berechnet)'))),
        actions));
    }
    if (S.status === 'connected') body.append(el('p', { class: 'small muted' }, 'Eine andere Identität wird erst beim nächsten Verbinden verwendet.'));
  };
  const rename = (e, nameEl) => {
    const input = el('input', { value: e.name, maxlength: 60 });
    const save = () => {
      const list = idList();
      const x = list.find((y) => y.id === e.id);
      if (x && input.value.trim() && input.value.trim() !== x.name) { x.name = input.value.trim(); x.updated = Date.now(); saveIdList(list); }
      renderIdentityRow(); render();
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } if (ev.key === 'Escape') { ev.stopPropagation(); render(); } });
    input.addEventListener('blur', save);
    nameEl.replaceWith(input);
    input.focus(); input.select();
  };
  const remove = async (e) => {
    const ok = await confirmDialog(
      `Die eindeutige ID ${e.uid || ''} und alle Rechte und Servergruppen, die daran hängen, gehen verloren – außer du hast die Identität exportiert.`,
      { title: `„${e.name}“ löschen?`, okLabel: 'Endgültig löschen', danger: true, icon: 'warn',
        extra: { label: 'Vorher exportieren', action: () => identityExport(e, identityManager) } });
    if (!ok) return;
    // remember the deletion, so a sync does not bring the identity back
    const del = store.get('idDeleted', []).filter((d) => d.uid !== e.uid);
    if (e.uid) del.push({ uid: e.uid, at: Date.now() });
    store.set('idDeleted', del);
    saveIdList(idList().filter((x) => x.id !== e.id));
    renderIdentityRow(); render();
    toast(`„${e.name}“ gelöscht`);
  };
  const create = async () => {
    try {
      const data = await identityApi('api/identity/new');
      const e = addIdentity(data);
      setActiveIdentity(e.id);
      renderIdentityRow(); render();
      toast(`Neue Identität „${e.name}“ erstellt`);
    } catch (err) { toast(err.message, 'error'); }
  };
  render();
  openModal('Identitäten', body, [
    el('button', { onclick: () => identityImport(identityManager) }, 'Importieren'),
    el('button', { onclick: create }, 'Neu erstellen'),
    el('button', { class: 'primary', onclick: () => closeModal() }, 'Fertig'),
  ]);
}

// ---------------------------------------------------------------- identity sync
// Encrypted backup of all identities on the bridge. Name + passphrase never leave
// the browser: PBKDF2 derives an AES key (encrypts the data) and a login token.
// The bridge stores only the encrypted data and a hash of the token.
const SYNC_ROUNDS = 600000;
const te = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(str) { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

function syncState() { return store.get('sync', null); }
function syncAvailable() { return !!(S.config && S.config.sync && window.isSecureContext && crypto.subtle); }

async function deriveSync(name, pass) {
  const norm = name.trim().toLowerCase();
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('ts3-webbridge sync v1\n' + norm), iterations: SYNC_ROUNDS }, base, 512));
  const vault = toHex(await crypto.subtle.digest('SHA-256', te.encode('ts3-webbridge vault v1\n' + norm)));
  return { name: name.trim(), vault, key: toB64(bits.slice(0, 32)), auth: toHex(bits.slice(32)), version: 0 };
}

async function syncKey(st) { return crypto.subtle.importKey('raw', fromB64(st.key), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function encryptVault(st, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await syncKey(st), te.encode(JSON.stringify(payload))));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  return toB64(all);
}
async function decryptVault(st, blob) {
  const all = fromB64(blob);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await syncKey(st), all.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { throw new Error('Die Sicherung konnte nicht entschlüsselt werden (falsche Passphrase?).'); }
}

async function syncApi(action, body) {
  const q = S.config.needs_access_password ? '?key=' + encodeURIComponent(accessKey()) : '';
  const res = await fetch('api/sync/' + action + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

/** Combine local and remote identities (by unique id) and deletions. */
function mergeIdentities(local, localDel, remote) {
  const deleted = new Map();
  for (const d of [...localDel, ...(remote.deleted || [])]) if (!deleted.has(d.uid) || deleted.get(d.uid) < d.at) deleted.set(d.uid, d.at);
  const byKey = new Map();
  const keyOf = (e) => e.uid || e.identity;
  for (const e of local) byKey.set(keyOf(e), { ...e });
  for (const r of remote.identities || []) {
    const k = keyOf(r);
    const l = byKey.get(k);
    if (!l) { byKey.set(k, { ...r, id: r.id || newId() }); continue; }
    if ((r.updated || 0) > (l.updated || 0)) { l.name = r.name; l.updated = r.updated; }
    if (idCounter(r.identity) > idCounter(l.identity)) l.identity = r.identity;
    l.level = Math.max(l.level || 0, r.level || 0);
  }
  const list = [...byKey.values()].filter((e) => !(e.uid && deleted.has(e.uid) && deleted.get(e.uid) >= (e.updated || 0)));
  return { list, deleted: [...deleted].map(([uid, at]) => ({ uid, at })) };
}
const vaultPayload = (list, deleted) => ({ v: 1, identities: list.map(({ id, name, identity, uid, level, updated }) => ({ id, name, identity, uid, level, updated })), deleted });
const canonical = (p) => JSON.stringify([...p.identities].sort((a, b) => (a.uid || '').localeCompare(b.uid || '')).map((e) => [e.uid, e.name, e.identity]).concat(p.deleted.map((d) => [d.uid, d.at]).sort()));

let syncTimer = null;
function scheduleSync() {
  if (!syncState()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow().catch((e) => console.warn('Sync', e)), 1500);
}

/** Load, merge, upload if needed. Returns a short status text. */
async function syncNow() {
  let st = syncState();
  if (!st || !syncAvailable()) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await syncApi('load', { vault: st.vault, auth: st.auth });
    if (r.status === 404) throw new Error('Die Sicherung gibt es nicht mehr (auf einem anderen Gerät gelöscht?). Melde den Sync ab und richte ihn neu ein.');
    if (r.status !== 200) throw new Error(r.data.error || `Fehler ${r.status}`);
    const remote = await decryptVault(st, r.data.blob);
    const merged = mergeIdentities(idList(), store.get('idDeleted', []), remote);
    S.syncing = true;
    try { saveIdList(merged.list); store.set('idDeleted', merged.deleted); } finally { S.syncing = false; }
    const payload = vaultPayload(merged.list, merged.deleted);
    st.version = r.data.version;
    if (canonical(payload) !== canonical({ identities: remote.identities || [], deleted: remote.deleted || [] })) {
      const w = await syncApi('save', { vault: st.vault, auth: st.auth, version: st.version, blob: await encryptVault(st, payload) });
      if (w.status === 409) continue; // changed meanwhile on another device: start over
      if (w.status !== 200) throw new Error(w.data.error || `Fehler ${w.status}`);
      st.version = w.data.version;
    }
    st.last = Date.now();
    store.set('sync', st);
    renderIdentityRow();
    return;
  }
  throw new Error('Die Sicherung wird gerade von einem anderen Gerät geändert. Bitte gleich noch einmal versuchen.');
}

/** Card at the top of the identity manager. */
function syncCard(rerender) {
  if (!S.config || !S.config.sync) return null;
  const st = syncState();
  const card = el('div', { class: 'sync-card' + (st ? ' on' : '') });
  if (!window.isSecureContext || !crypto.subtle) {
    card.append(el('strong', {}, 'Sync nicht verfügbar'), el('p', { class: 'small muted' }, 'Der Identitäts-Sync braucht eine HTTPS-Verbindung.'));
    return card;
  }
  if (!st) {
    card.append(
      el('strong', {}, '☁ Identitäten sichern'),
      el('p', { class: 'small muted' }, 'Sichere deine Identitäten verschlüsselt auf dieser Brücke und nutze sie auf deinen anderen Geräten. Niemand außer dir kann sie lesen.'),
      el('div', { class: 'id-actions' },
        el('button', { class: 'primary', onclick: () => syncDialog('create') }, 'Einrichten'),
        el('button', { onclick: () => syncDialog('login') }, 'Anmelden')));
    return card;
  }
  const when = st.last ? new Date(st.last).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'noch nie';
  const status = el('p', { class: 'small muted' }, `Zuletzt abgeglichen: ${when}`);
  const now = el('button', { class: 'primary' }, 'Jetzt abgleichen');
  now.addEventListener('click', async () => {
    now.disabled = true; status.textContent = 'Wird abgeglichen…';
    try { await syncNow(); toast('Identitäten abgeglichen'); rerender(); } catch (e) { status.textContent = e.message; status.className = 'small sync-error'; now.disabled = false; }
  });
  card.append(
    el('strong', {}, `☁ Sync aktiv: ${st.name}`), status,
    el('div', { class: 'id-actions' }, now,
      el('button', { onclick: async () => {
        if (await confirmDialog('Dieses Gerät gleicht dann nicht mehr ab. Die Identitäten bleiben hier und in der Sicherung erhalten.', { title: 'Sync auf diesem Gerät beenden?', okLabel: 'Abmelden' })) {
          store.del('sync'); toast('Sync auf diesem Gerät beendet'); rerender();
        }
      } }, 'Abmelden'),
      el('button', { class: 'danger', onclick: async () => {
        if (!(await confirmDialog('Die verschlüsselte Sicherung wird von der Brücke gelöscht. Deine Identitäten in diesem Browser bleiben erhalten, andere Geräte gleichen aber nicht mehr ab.', { title: 'Sicherung löschen?', okLabel: 'Sicherung löschen', danger: true }))) return;
        const r = await syncApi('delete', { vault: st.vault, auth: st.auth });
        if (r.status !== 200) return toast(r.data.error || 'Löschen fehlgeschlagen', 'error');
        store.del('sync'); toast('Sicherung gelöscht'); rerender();
      } }, 'Sicherung löschen')));
  return card;
}

/** Set up a new backup ('create') or connect this device to an existing one ('login'). */
function syncDialog(mode) {
  const create = mode === 'create';
  const name = el('input', { autocomplete: 'username', maxlength: 64, placeholder: 'z. B. eiki' });
  const pass = el('input', { type: 'password', autocomplete: create ? 'new-password' : 'current-password' });
  const pass2 = el('input', { type: 'password', autocomplete: 'new-password' });
  const err = el('div', { class: 'alert error', hidden: true });
  const info = el('div', { class: 'alert info', hidden: true });
  const body = el('form', { class: 'sync-form' },
    el('p', { class: 'small muted' }, create
      ? 'Wähle einen Namen und eine Passphrase. Damit meldest du dich auf anderen Geräten an. Die Passphrase verlässt deinen Browser nie – deshalb kann sie auch niemand zurücksetzen. Schreib sie dir gut auf!'
      : 'Gib den Namen und die Passphrase ein, die du beim Einrichten gewählt hast. Die gesicherten Identitäten werden mit denen in diesem Browser zusammengeführt.'),
    el('label', {}, 'Name', name),
    el('label', {}, 'Passphrase', pass),
    create ? el('label', {}, 'Passphrase wiederholen', pass2) : null,
    create ? el('p', { class: 'small muted' }, 'Tipp: Mehrere Wörter sind sicher und gut zu merken, z. B. „Kaffee Tisch Regen Gitarre“. Mindestens 10 Zeichen.') : null,
    info, err);
  const ok = el('button', { class: 'primary', type: 'submit' }, create ? 'Sicherung anlegen' : 'Anmelden');
  const fail = (m) => { err.textContent = m; err.hidden = false; info.hidden = true; ok.disabled = false; };
  body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    if (name.value.trim().length < 3) return fail('Der Name muss mindestens 3 Zeichen haben.');
    if (pass.value.length < 10) return fail('Die Passphrase muss mindestens 10 Zeichen haben.');
    if (create && pass.value !== pass2.value) return fail('Die beiden Passphrasen sind nicht gleich.');
    ok.disabled = true;
    info.textContent = 'Schlüssel wird berechnet… (das dauert absichtlich einen Moment)'; info.hidden = false;
    try {
      const st = await deriveSync(name.value, pass.value);
      if (create) {
        const payload = vaultPayload(idList(), store.get('idDeleted', []));
        const r = await syncApi('save', { vault: st.vault, auth: st.auth, version: 0, blob: await encryptVault(st, payload) });
        if (r.status !== 200) return fail(r.data.error || `Fehler ${r.status}`);
        st.version = r.data.version; st.last = Date.now();
        store.set('sync', st);
        toast('Sicherung angelegt – melde dich auf anderen Geräten mit diesem Namen an');
      } else {
        const r = await syncApi('load', { vault: st.vault, auth: st.auth });
        if (r.status !== 200) return fail(r.data.error || `Fehler ${r.status}`);
        await decryptVault(st, r.data.blob); // check before saving the login
        store.set('sync', st);
        await syncNow();
        toast('Angemeldet – Identitäten abgeglichen');
      }
      identityManager();
    } catch (e) { fail(e.message); }
  });
  ok.addEventListener('click', () => body.requestSubmit());
  openModal(create ? 'Sicherung einrichten' : 'Mit Sicherung anmelden', body, [el('button', { type: 'button', onclick: () => identityManager() }, 'Zurück'), ok]);
}

function showLoginError(text) {
  const e = $('#login-error');
  e.textContent = text;
  e.hidden = !text;
}
function showLoginInfo(text) {
  const e = $('#login-info');
  e.textContent = text || '';
  e.hidden = !text;
}

async function startLogin() {
  showLoginError('');
  const params = {
    t: 'connect',
    nickname: $('#f-nickname').value.trim(),
    address: S.config.allow_any_server ? $('#f-address').value.trim() : null,
    server_password: $('#f-server-password').value,
    channel: $('#f-channel').value.trim(),
    channel_password: $('#f-channel-password').value,
  };
  if (params.nickname.length < 3) return showLoginError('Der Nickname muss mindestens 3 Zeichen haben.');
  if ($('#f-remember').checked) {
    store.set('login', { nickname: params.nickname, address: params.address, channel: params.channel });
    if (S.config.needs_access_password) store.set('access', $('#f-access').value);
  }
  S.connParams = params;
  S.access = $('#f-access').value;
  S.userDisconnect = false;
  S.reconnectTries = 0;
  $('#login-btn').disabled = true;
  showLoginInfo('Audio wird vorbereitet…');
  await setupAudio();
  openSocket();
}

// ---------------------------------------------------------------- websocket
function openSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = location.pathname.replace(/[^/]*$/, '');
  const q = S.config.needs_access_password ? '?key=' + encodeURIComponent(S.access || '') : '';
  const ws = new WebSocket(`${proto}//${location.host}${base}ws${q}`);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  showLoginInfo('Verbinde mit der Brücke…');
  let opened = false;

  ws.onopen = () => {
    opened = true;
    S.identity = activeIdentity();
    setupCodecs();
    const msg = Object.assign({}, S.connParams, { identity: S.identity ? S.identity.identity : null, opus: S.opusDown });
    ws.send(JSON.stringify(msg));
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      handleMessage(m);
    } else if (S.opusDown) {
      if (S.playbackNode && !S.outputMuted && e.data.byteLength) decodeOpus(e.data);
    } else if (S.playbackNode && !S.outputMuted) {
      const pcm = new Int16Array(e.data);
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      S.playbackNode.port.postMessage({ frame: f }, [f.buffer]);
    }
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    S.ws = null;
    stopTransmit();
    if (!opened) {
      leaveApp(S.config.needs_access_password
        ? 'Keine Verbindung zur Brücke. Ist das Zugangspasswort richtig?'
        : 'Keine Verbindung zur Brücke möglich.');
      return;
    }
    if (S.status === 'connected' && !S.userDisconnect && S.reconnectTries < 5) {
      S.reconnectTries++;
      setBanner(`Verbindung zur Brücke verloren – neuer Versuch (${S.reconnectTries}/5)…`);
      setStatus('connecting');
      setTimeout(openSocket, 1500 * S.reconnectTries);
      return;
    }
    if (!S.userDisconnect) leaveApp(e.reason || S.lastError || 'Verbindung beendet.');
  };
}

function send(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

function handleMessage(m) {
  switch (m.t) {
    case 'status': return onStatus(m);
    case 'identity': {
      // The bridge reports the identity it uses (new one, or a higher security level).
      const e = addIdentity({ identity: m.identity, uid: m.uid }, idList().length ? '' : 'Standard');
      if (!S.identity || S.identity.uid === m.uid) setActiveIdentity(e.id);
      S.identity = e;
      if (S.status === 'connected') historyStart();
      return;
    }
    case 'state': return onState(m);
    case 'talking': S.talking = new Set(m.ids); return updateTalking();
    case 'chat': return onChat(m);
    case 'poke': return onPoke(m);
    case 'log': return onLog(m);
    case 'can_talk': S.canTalk = m.can; return updateTxState();
    case 'admin_result': return onAdminResult(m);
    case 'error':
      S.lastError = m.message;
      if (S.status !== 'connected') showLoginError(m.message);
      else { toast(m.message, 'error'); addMsg(S.activeTab, { sys: true, cls: 'err', text: m.message }); }
      return;
    case 'info':
      if (S.status !== 'connected') showLoginInfo(m.message); else toast(m.message);
      return;
  }
}

function onStatus(m) {
  setStatus(m.state);
  if (m.state === 'connecting') showLoginInfo('Verbinde mit dem Server…');
  if (m.state === 'connected') {
    S.reconnectTries = 0;
    setBanner('');
    enterApp();
    historyStart();
    sound(S.wasReconnecting ? 'reconnected' : 'connected');
    S.wasReconnecting = false;
    // restore mute states
    if (S.inputMuted || S.outputMuted) send({ t: 'set_mute', input: S.inputMuted, output: S.outputMuted });
  }
  if (m.state === 'reconnecting') {
    setBanner('Verbindung zum Server unterbrochen – verbinde neu…');
    if (!S.wasReconnecting) sound('lost');
    S.wasReconnecting = true;
  }
  if (m.state === 'disconnected') {
    const r = m.reason || '';
    sound(/gebannt/i.test(r) ? 'banned' : /gekickt/i.test(r) ? 'kicked' : 'disconnected');
    S.wasReconnecting = false;
    S.userDisconnect = true;
    if (S.ws) S.ws.close();
    leaveApp(m.reason && m.reason !== 'Verbindung getrennt' ? m.reason : '');
  }
}

function setStatus(st) {
  S.status = st;
  const dot = $('#status-dot');
  dot.className = 'status-dot ' + (st === 'connected' ? 'connected' : st === 'disconnected' ? '' : 'connecting');
  dot.title = { connected: 'Verbunden', connecting: 'Verbinde…', reconnecting: 'Verbinde neu…', disconnected: 'Getrennt' }[st] || st;
}

function setBanner(text) {
  const b = $('#banner');
  b.textContent = text;
  b.hidden = !text;
}

function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#login-btn').disabled = false;
  showLoginInfo('');
  if (!S.tabs.size) {
    S.tabs.set('server', { title: 'Server', msgs: [], unread: 0 });
    S.tabs.set('channel', { title: 'Kanal', msgs: [], unread: 0 });
  }
  renderTabs();
  updateToolbar();
  updateTxState();
}

function leaveApp(error) {
  historyStop();
  shareStop();
  admReset();
  stopTransmit();
  S.miniLast = null;
  if (S.mini) closeMini();
  S.ownId = null;
  S.channels.clear();
  S.clients.clear();
  S.tabs.clear();
  S.activeTab = 'channel';
  S.welcomeShown = false;
  S.sentVolumes.clear();
  S.talking.clear();
  setStatus('disconnected');
  setBanner('');
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-btn').disabled = false;
  showLoginInfo('');
  showLoginError(error || '');
  updateIdentityHint();
  if (S.playbackNode) S.playbackNode.port.postMessage({ reset: true });
}

function disconnect() {
  S.userDisconnect = true;
  send({ t: 'disconnect', message: 'Funkraum' });
  setTimeout(() => { if (S.ws) S.ws.close(); leaveApp(''); }, 400);
}

// ---------------------------------------------------------------- state & tree
function onState(m) {
  const prevClients = S.clients;
  const prevOwnCh = prevClients.get(S.ownId)?.channel;
  S.ownId = m.own_id;
  S.server = m.server;
  S.channels = new Map(m.channels.map((c) => [c.id, c]));
  S.clients = new Map(m.clients.map((c) => [c.id, c]));
  if (prevClients.size) channelSounds(prevClients, prevOwnCh);
  const me = S.clients.get(S.ownId);
  if (me) {
    S.inputMuted = me.input_muted;
    S.outputMuted = me.output_muted;
    S.away = me.away != null;
  }
  $('#server-name').textContent = m.server.name || 'Server';
  const stats = [];
  if (m.ping_ms != null) stats.push(`${Math.round(m.ping_ms)} ms`);
  if (m.packet_loss != null && m.packet_loss > 0.005) stats.push(`${(m.packet_loss * 100).toFixed(1)} % Verlust`);
  $('#net-stats').textContent = stats.join(' · ');

  if (!S.welcomeShown && m.server.welcome_message) {
    S.welcomeShown = true;
    addMsg('server', { sys: true, cls: 'welcome', html: bbcode(m.server.welcome_message) });
    if (m.server.host_message) addMsg('server', { sys: true, cls: 'welcome', html: bbcode(m.server.host_message) });
  }

  // re-apply stored per-user volumes
  for (const c of S.clients.values()) {
    if (c.id === S.ownId || !c.uid) continue;
    const v = store.get('vol.' + c.uid, null);
    if (v != null && S.sentVolumes.get(c.id) !== v) {
      send({ t: 'volume', client: c.id, volume: v });
      S.sentVolumes.set(c.id, v);
    }
  }
  // private tabs: find the partner again by unique id (the client id changes on reconnect)
  for (const tab of S.tabs.values()) {
    if (!tab.closable) continue;
    const c = tab.uid ? [...S.clients.values()].find((x) => x.uid === tab.uid) : S.clients.get(tab.clientId);
    if (c) {
      tab.clientId = c.id;
      tab.title = c.name;
    } else if (tab.uid) {
      tab.clientId = null;
      if (!tab.title.endsWith(' (offline)')) tab.title += ' (offline)';
    }
  }
  historyOnState();
  shareSync();
  const ch = me && S.channels.get(me.channel);
  if (S.tabs.has('channel')) S.tabs.get('channel').title = ch ? ch.name : 'Kanal';
  renderTree();
  renderTabs();
  updateToolbar();
  updateTxState();
}

/** Sounds for channel changes (like the TeamSpeak 3 client): compare with the last state. */
function channelSounds(prev, prevOwnCh) {
  const ownCh = S.clients.get(S.ownId)?.channel;
  if (ownCh == null) return;
  if (prevOwnCh != null && ownCh !== prevOwnCh) {
    const mine = S.joinRequestedAt && Date.now() - S.joinRequestedAt < 5000;
    S.joinRequestedAt = 0;
    if (mine) sound('switched');
    else if (S.channelKickAt && Date.now() - S.channelKickAt < 2000) sound('channel_kick');
    else sound('moved');
    return;
  }
  let joined = false, left = false;
  for (const c of S.clients.values()) {
    if (c.id === S.ownId || c.channel !== ownCh || c.is_query) continue;
    const before = prev.get(c.id);
    if (!before || before.channel !== ownCh) joined = true;
  }
  for (const c of prev.values()) {
    if (c.id === S.ownId || c.channel !== ownCh || c.is_query) continue;
    const now = S.clients.get(c.id);
    if (!now || now.channel !== ownCh) left = true;
  }
  if (joined) sound('user_joined');
  else if (left) sound('user_left');
}

function sortedChildren(parentId) {
  const list = [...S.channels.values()].filter((c) => c.parent === parentId);
  const byOrder = new Map(list.map((c) => [c.order, c]));
  const out = [];
  const seen = new Set();
  let cur = byOrder.get(0);
  while (cur && !seen.has(cur.id)) { out.push(cur); seen.add(cur.id); cur = byOrder.get(cur.id); }
  for (const c of list) if (!seen.has(c.id)) out.push(c);
  return out;
}

/** ServerQuery clients (bots, rank systems …) are hidden unless enabled in the settings. */
function visibleClient(c) { return settings.showQuery || !c.is_query || c.id === S.ownId; }

function clientsIn(chId) {
  return [...S.clients.values()].filter((c) => c.channel === chId && visibleClient(c))
    .sort((a, b) => (b.talk_power - a.talk_power) || a.name.localeCompare(b.name, 'de'));
}

const SPACER_RE = /^\[([lrc*]?)spacer[^\]]*\](.*)$/i;

function renderTree() {
  const tree = $('#tree');
  const filter = $('#tree-filter').value.trim().toLowerCase();
  const scroll = tree.scrollTop;
  tree.textContent = '';
  const me = S.clients.get(S.ownId);

  const srv = el('div', { class: 'node server', html: `<span class="ico">${ICON.server}</span>` },
    el('span', { class: 'name' }, S.server ? S.server.name : ''));
  srv.addEventListener('click', (e) => showServerInfo());
  tree.append(srv);

  const matches = (ch) => {
    if (!filter) return true;
    if (ch.name.toLowerCase().includes(filter)) return true;
    if (clientsIn(ch.id).some((c) => c.name.toLowerCase().includes(filter))) return true;
    return sortedChildren(ch.id).some(matches);
  };

  const renderChannel = (ch, container) => {
    if (!matches(ch)) return;
    const clients = clientsIn(ch.id);
    const sp = ch.parent === 0 && ch.name.match(SPACER_RE);
    let node;
    if (sp) {
      let text = sp[2];
      if (sp[1] === '*' && text) text = text.repeat(Math.ceil(40 / text.length)).slice(0, 40);
      node = el('div', { class: 'node channel spacer', style: `justify-content:${sp[1] === 'l' ? 'flex-start' : sp[1] === 'r' ? 'flex-end' : 'center'}` }, text);
    } else {
      const full = ch.max_clients >= 0 && clients.length >= ch.max_clients;
      const cls = ['node', 'channel'];
      if (full) cls.push('full');
      if (ch.has_password) cls.push('locked');
      if (me && me.channel === ch.id) cls.push('current');
      if (S.selected && S.selected.type === 'channel' && S.selected.id === ch.id) cls.push('selected');
      const extra = el('span', { class: 'extra' });
      if (ch.is_default) extra.append(el('span', { class: 'tag' }, 'Standard'));
      if (ch.has_password) extra.append(el('span', { class: 'ico', html: ICON.lock, title: 'Passwortgeschützt' }));
      if (ch.max_clients >= 0) extra.append(el('span', { class: 'count', title: 'Clients / Maximum' }, `${clients.length}/${ch.max_clients}`));
      else if (clients.length) extra.append(el('span', { class: 'count', title: 'Clients im Kanal' }, String(clients.length)));
      if (!clients.length) cls.push('empty');
      node = el('div', { class: cls.join(' '), role: 'treeitem', title: ch.topic || '' },
        el('span', { class: 'ico', html: ICON.channel }),
        el('span', { class: 'name' }, ch.name),
        extra);
      bindTreeNode(node, () => select('channel', ch.id, node), () => joinChannel(ch.id), (e) => channelMenu(ch, e));
    }
    container.append(node);
    const kids = el('div', { class: 'children' });
    const group = el('div', { class: 'clients' });
    for (const c of clients) {
      if (filter && !c.name.toLowerCase().includes(filter) && !ch.name.toLowerCase().includes(filter)) continue;
      group.append(renderClient(c));
    }
    if (group.childNodes.length) kids.append(group);
    for (const sub of sortedChildren(ch.id)) renderChannel(sub, kids);
    if (kids.childNodes.length) container.append(kids);
  };

  for (const ch of sortedChildren(0)) renderChannel(ch, tree);
  if (S.mini) renderMini();
  tree.scrollTop = scroll;
  updateTalking();
}

function renderClient(c) {
  const me = c.id === S.ownId;
  const cls = ['node', 'client'];
  if (me) cls.push('me');
  if (c.is_query) cls.push('query');
  if (S.selected && S.selected.type === 'client' && S.selected.id === c.id) cls.push('selected');
  const avatar = clientAvatar(c);
  const extra = el('span', { class: 'extra' });
  if (c.is_channel_commander) extra.append(el('span', { class: 'tag', title: 'Channel Commander' }, 'CC'));
  if (c.is_priority_speaker) extra.append(el('span', { class: 'tag', title: 'Priority Speaker' }, 'PS'));
  if (c.is_recording) extra.append(el('span', { class: 'tag', title: 'Nimmt auf' }, '● REC'));
  const screen = me ? (SH.sending ? { id: 0, audio: SH.sending.audio } : null) : shareOf(c.id);
  if (screen) {
    const watching = SH.session && SH.session.viewers.has(screen.id);
    const tag = el('span', { class: 'tag screen-tag' + (watching ? ' on' : ''), title: me ? 'Du teilst deinen Bildschirm' : `Teilt den Bildschirm${screen.audio ? ' (mit Ton)' : ''} – klicken zum Ansehen`, html: FunkShare.ICON.screen });
    if (!me) tag.addEventListener('click', (e) => { e.stopPropagation(); if (watching) SH.session.unwatch(screen.id); else shareWatch(screen.id); renderTree(); });
    extra.append(tag);
  }
  if (c.talk_request != null) extra.append(el('span', { class: 'tag', title: c.talk_request || 'Sprecherlaubnis angefragt' }, '✋'));
  for (const g of c.server_groups.slice(0, 2)) if (!/^guest$|^gast$/i.test(g)) extra.append(el('span', { class: 'tag' }, g));
  if (c.country) extra.append(el('span', { class: 'tag', title: c.country }, c.country));
  const vol = c.uid != null ? store.get('vol.' + c.uid, null) : null;
  if (vol === 0) extra.append(el('span', { class: 'tag', title: 'Lokal stummgeschaltet' }, 'lokal stumm'));
  const name = el('span', { class: 'name' }, c.name, c.away != null ? el('span', { class: 'away' }, ` [abwesend${c.away ? ': ' + c.away : ''}]`) : null);
  const node = el('div', { class: cls.join(' '), 'data-client': c.id, role: 'treeitem' },
    avatar, name, extra);
  bindTreeNode(node, () => select('client', c.id, node), () => { if (!me) openPrivate(c.id); }, (e) => clientMenu(c, e));
  return node;
}

/**
 * Round avatar with the first letter. Its look shows the audio state like the
 * official client: sound off → crossed-out speaker (red), microphone muted → mic icon
 * (orange), deactivated hardware → same icons in grey. The ring shows talking.
 */
function clientAvatar(c) {
  const micOff = c.input_muted || !c.input_hardware_enabled;
  const soundOff = c.output_muted || !c.output_hardware_enabled;
  const cls = ['talk-dot', 'avatar'];
  let content = initial(c.name);
  const titles = [];
  if (soundOff) {
    cls.push('state', c.output_muted ? 'sound-off' : 'hw-off');
    content = el('span', { class: 'ico', html: ICON.speakerOff });
    titles.push(c.output_muted ? 'Sound aus' : 'Lautsprecher deaktiviert');
  } else if (micOff) {
    cls.push('state', c.input_muted ? 'mic-off' : 'hw-off');
    content = el('span', { class: 'ico', html: ICON.micOff });
  }
  if (micOff) titles.push(c.input_muted ? 'Mikrofon stumm' : 'Mikrofon deaktiviert');
  const a = el('span', { class: cls.join(' '), style: `--hue:${nameHue(c.name)}`, title: titles.join(' · ') || null }, content);
  // both: small mic badge on the speaker avatar
  if (soundOff && micOff) a.append(el('span', { class: 'badge-mic' + (c.input_muted ? '' : ' hw'), html: ICON.micOff }));
  return a;
}

/** Stable colour per nickname for the avatar. */
function nameHue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}
function initial(name) {
  const m = name.match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : name.charAt(0) || '?').toUpperCase();
}

// ---------------------------------------------------------------- Opus (WebCodecs)
// The bridge talks raw PCM (96 kB/s per direction) unless the browser can encode
// and decode Opus itself; then it is about 8 kB/s. Both directions fall back
// to PCM on their own.
const OPUS_CFG = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 };
const ENC_CFG = Object.assign({ bitrate: 64000, opus: { frameDuration: 20000 } }, OPUS_CFG);
S.opusSupport = { enc: false, dec: false };
async function detectOpus() {
  try { S.opusSupport.enc = typeof AudioEncoder === 'function' && (await AudioEncoder.isConfigSupported(ENC_CFG)).supported; } catch { S.opusSupport.enc = false; }
  try { S.opusSupport.dec = typeof AudioDecoder === 'function' && (await AudioDecoder.isConfigSupported(OPUS_CFG)).supported; } catch { S.opusSupport.dec = false; }
}

function setupCodecs() {
  closeEncoder(); closeDecoder();
  // What the bridge will send for this connection (decided once, at connect).
  S.opusDown = S.opusSupport.dec && makeDecoder();
  if (S.opusSupport.enc) makeEncoder();
}

function makeDecoder() {
  try {
    S.decTs = 0;
    S.decoder = new AudioDecoder({
      output: (d) => {
        const f = new Float32Array(d.numberOfFrames);
        d.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
        d.close();
        if (S.playbackNode && !S.outputMuted) S.playbackNode.port.postMessage({ frame: f }, [f.buffer]);
      },
      error: (e) => { console.warn('Opus decoder error', e); S.decoder = null; },
    });
    S.decoder.configure(OPUS_CFG);
    return true;
  } catch (e) {
    console.warn('No Opus decoder', e);
    S.decoder = null;
    return false;
  }
}

function makeEncoder() {
  try {
    S.encTs = 0;
    S.encoder = new AudioEncoder({
      output: (chunk) => {
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        if (S.ws && S.ws.readyState === 1 && S.ws.bufferedAmount < 64 * 1024) S.ws.send(b);
      },
      error: (e) => { console.warn('Opus encoder error, using PCM', e); S.encoder = null; },
    });
    S.encoder.configure(ENC_CFG);
  } catch (e) {
    console.warn('No Opus encoder', e);
    S.encoder = null;
  }
}

function decodeOpus(buf) {
  // A broken decoder must not stop playback for the rest of the session.
  if (!S.decoder || S.decoder.state === 'closed') makeDecoder();
  if (!S.decoder) return;
  try {
    S.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: S.decTs, data: buf }));
    S.decTs += 20000;
  } catch (e) { console.warn('Opus decode failed', e); closeDecoder(); }
}

function closeEncoder() { if (S.encoder) { try { S.encoder.close(); } catch { /* ignore */ } } S.encoder = null; }
function closeDecoder() { if (S.decoder) { try { S.decoder.close(); } catch { /* ignore */ } } S.decoder = null; }

function select(type, id, node) {
  S.selected = { type, id };
  document.querySelectorAll('.node.selected').forEach((n) => n.classList.remove('selected'));
  if (node) node.classList.add('selected');
}

const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 350;

/**
 * Mouse: click = select, double click = activate (join channel / private chat),
 * right click = menu. Touch: tap = select, double tap = activate, long press = menu.
 * Keyboard: Enter = activate, menu key or Shift+F10 = menu.
 */
function bindTreeNode(node, onSelect, onActivate, onMenu) {
  let pointer = 'mouse';
  let timer = null;
  let longPressed = false;
  let start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  node.tabIndex = -1;
  node.addEventListener('pointerdown', (e) => {
    pointer = e.pointerType || 'mouse';
    if (pointer === 'mouse' || !e.isPrimary) return;
    longPressed = false;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      onSelect();
      if (navigator.vibrate) navigator.vibrate(15);
      onMenu({ clientX: start.x, clientY: start.y, preventDefault() {}, stopPropagation() {} });
    }, LONG_PRESS_MS);
  });
  // scrolling the list is not a long press
  node.addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', (e) => {
    // after a long press the menu just opened: this click must not close it
    if (longPressed) { longPressed = false; e.stopPropagation(); return; }
    onSelect();
    if (pointer === 'mouse') return; // double click comes as dblclick
    const now = Date.now();
    if (S.lastTap && S.lastTap.node === node && now - S.lastTap.time < DOUBLE_TAP_MS) {
      S.lastTap = null;
      onActivate();
    } else {
      S.lastTap = { node, time: now };
    }
  });
  node.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (pointer === 'mouse') onActivate();
  });
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // touch: the long press timer opens the menu (iOS sends no contextmenu at all)
    if (pointer !== 'mouse') return;
    onSelect();
    onMenu(e);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onActivate(); }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      onSelect();
      const r = node.getBoundingClientRect();
      onMenu({ clientX: r.left + 24, clientY: r.bottom, preventDefault() {}, stopPropagation() {} });
    }
  });
}

function updateTalking() {
  document.querySelectorAll('.node.client').forEach((n) => {
    const id = Number(n.dataset.client);
    const talking = S.talking.has(id) || (id === S.ownId && S.transmitting);
    n.querySelector('.talk-dot').classList.toggle('talking', talking);
  });
  updateMiniTalking();
}

function joinChannel(id) {
  const ch = S.channels.get(id);
  const me = S.clients.get(S.ownId);
  if (!ch || (me && me.channel === id)) return;
  if (ch.has_password) {
    promptDialog(`Passwort für „${ch.name}“`, '', { password: true, label: 'Kanalpasswort' }).then((pw) => {
      if (pw != null) { S.joinRequestedAt = Date.now(); send({ t: 'join', channel: id, password: pw }); }
    });
  } else { S.joinRequestedAt = Date.now(); send({ t: 'join', channel: id }); }
}

// ---------------------------------------------------------------- context menus
function openMenu(ev, title, items) {
  const menu = $('#ctx-menu');
  menu.textContent = '';
  if (title) menu.append(el('div', { class: 'title' }, title));
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.append(el('hr')); continue; }
    if (it.node) { menu.append(it.node); continue; }
    menu.append(el('button', { class: it.danger ? 'danger' : '', onclick: () => { closeMenu(); it.action(); } }, it.label));
  }
  menu.hidden = false;
  const x = ev.clientX ?? 20, y = ev.clientY ?? 20;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  ev.stopPropagation();
}
function closeMenu() { $('#ctx-menu').hidden = true; }
document.addEventListener('click', (e) => { if (!$('#ctx-menu').contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#help-layer').hidden) { closeHelp(); return; }
  closeMenu(); closeModal();
});

// ---------------------------------------------------------------- help overlay
// The help page opens above the app (the TeamSpeak connection keeps running).
// Ctrl/middle click on a help link still opens it in a new tab.
function openHelp(section = '') {
  const frame = $('#help-iframe');
  const url = 'help.html?embedded=1' + (section ? '#' + section : '');
  if (!frame.getAttribute('src')) frame.setAttribute('src', url);
  else if (section) frame.contentWindow?.postMessage({ tsweb: 'help-goto', section }, location.origin);
  $('#help-layer').hidden = false;
  document.body.classList.add('help-open');
  setTimeout(() => frame.focus(), 50);
}
function closeHelp() {
  $('#help-layer').hidden = true;
  document.body.classList.remove('help-open');
}
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="help.html"]');
  if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openHelp((a.getAttribute('href').split('#')[1]) || '');
});
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.tsweb === 'help-close') closeHelp();
});

function channelMenu(ch, ev) {
  const me = S.clients.get(S.ownId);
  const inside = me && me.channel === ch.id;
  openMenu(ev, ch.name, [
    !inside && { label: 'Kanal betreten', action: () => joinChannel(ch.id) },
    { label: 'Kanalinfo', action: () => showChannelInfo(ch.id) },
    '-',
    { label: 'Unterkanal erstellen', action: () => createChannelDialog(ch.id) },
    { label: 'Kanal bearbeiten', action: () => openChannelEditor(ch.id) },
    { label: 'Kanal verschieben', action: () => openChannelMove(ch.id) },
    { label: 'Kanalrechte', action: () => openChannelEditor(ch.id, 'perms') },
    { label: 'Kanal löschen', danger: true, action: () => confirmDialog('Der Kanal wird mit allen Unterkanälen gelöscht. Wer darin ist, wird in den Standardkanal verschoben.', { title: `Kanal „${ch.name}“ löschen?`, okLabel: 'Löschen', danger: true }).then((ok) => ok && send({ t: 'delete_channel', channel: ch.id, force: true })) },
  ]);
}

function clientMenu(c, ev) {
  const isMe = c.id === S.ownId;
  const myCh = S.clients.get(S.ownId)?.channel;
  const items = [];
  if (isMe) {
    items.push({ label: 'Nickname ändern', action: () => promptDialog('Nickname ändern', c.name, { label: 'Neuer Nickname' }).then((n) => n && send({ t: 'set_name', name: n })) });
    items.push({ label: 'Beschreibung setzen', action: () => promptDialog('Beschreibung', c.description, { label: 'Deine Beschreibung' }).then((d) => d != null && send({ t: 'set_description', client: c.id, description: d })) });
    items.push({ label: c.is_channel_commander ? 'Channel Commander aus' : 'Channel Commander an', action: () => send({ t: 'set_commander', commander: !c.is_channel_commander }) });
    items.push({ label: 'Berechtigungsschlüssel einlösen', action: () => promptDialog('Berechtigungsschlüssel einlösen', '', { label: 'Schlüssel (z. B. ServerAdmin-Token)' }).then((t) => t && send({ t: 'use_token', token: t })) });
    items.push({ label: 'Info', action: () => showClientInfo(c.id) });
    items.push(...clientAdminItems(c));
  } else {
    const screen = shareOf(c.id);
    if (screen) {
      const watching = SH.session && SH.session.viewers.has(screen.id);
      items.push({ label: watching ? 'Bildschirm schließen' : 'Bildschirm ansehen', action: () => (watching ? SH.session.unwatch(screen.id) : shareWatch(screen.id)) }, '-');
    }
    items.push({ label: 'Private Nachricht', action: () => openPrivate(c.id) });
    items.push({ label: 'Anstupsen (Poke)', action: () => promptDialog(`${c.name} anstupsen`, '', { label: 'Nachricht' }).then((t) => t != null && send({ t: 'poke', client: c.id, text: t })) });
    items.push({ label: 'Info', action: () => showClientInfo(c.id) });
    if (c.uid) {
      const cur = store.get('vol.' + c.uid, 1);
      const label = el('div', {}, `Lautstärke: ${Math.round(cur * 100)} %`);
      const slider = el('input', { type: 'range', min: 0, max: 300, step: 5, value: Math.round(cur * 100) });
      slider.addEventListener('input', () => {
        const v = slider.value / 100;
        label.textContent = `Lautstärke: ${slider.value} %`;
        setClientVolume(c, v);
      });
      slider.addEventListener('click', (e) => e.stopPropagation());
      items.push('-', { node: el('div', { class: 'slider' }, label, slider) });
      items.push({ label: cur === 0 ? 'Lokale Stummschaltung aufheben' : 'Lokal stummschalten', action: () => {
        if (cur === 0) setClientVolume(c, store.get('volprev.' + c.uid, 1));
        else { store.set('volprev.' + c.uid, cur); setClientVolume(c, 0); }
        renderTree();
      } });
    }
    items.push('-');
    if (myCh != null && c.channel !== myCh) items.push({ label: 'In meinen Kanal ziehen', action: () => send({ t: 'move_client', client: c.id, channel: myCh }) });
    items.push({ label: 'Aus dem Kanal kicken', danger: true, action: () => promptDialog(`${c.name} aus dem Kanal kicken`, '', { label: 'Grund (optional)' }).then((r) => r != null && send({ t: 'kick', client: c.id, from: 'channel', reason: r })) });
    items.push({ label: 'Vom Server kicken', danger: true, action: () => promptDialog(`${c.name} vom Server kicken`, '', { label: 'Grund (optional)' }).then((r) => r != null && send({ t: 'kick', client: c.id, from: 'server', reason: r })) });
    items.push(...clientAdminItems(c));
  }
  openMenu(ev, c.name, items);
}

function setClientVolume(c, v) {
  store.set('vol.' + c.uid, v);
  S.sentVolumes.set(c.id, v);
  send({ t: 'volume', client: c.id, volume: v });
}

// ---------------------------------------------------------------- modals
let modalResolve = null;
function openModal(title, body, buttons = [], { wide = false } = {}) {
  $('#modal-title').textContent = title;
  $('#modal-backdrop .modal').classList.toggle('wide', wide);
  const b = $('#modal-body');
  b.textContent = '';
  b.append(body);
  const f = $('#modal-foot');
  f.textContent = '';
  for (const btn of buttons) f.append(btn);
  $('#modal-backdrop').hidden = false;
  const first = b.querySelector('input, textarea, select') || f.querySelector('.primary');
  if (first) setTimeout(() => first.focus(), 30);
}
function closeModal(value = null) {
  if ($('#modal-backdrop').hidden) return;
  $('#modal-backdrop').hidden = true;
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(value); }
  if (S.onModalClose) { const f = S.onModalClose; S.onModalClose = null; f(); }
}

function promptDialog(title, value = '', { label = '', password = false, multiline = false } = {}) {
  return new Promise((resolve) => {
    const input = multiline ? el('textarea', { rows: 4 }) : el('input', { type: password ? 'password' : 'text' });
    input.value = value || '';
    const form = el('form', {}, el('label', {}, label, input));
    const ok = el('button', { class: 'primary', type: 'submit' }, 'OK');
    form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; modalResolve = null; closeModal(); resolve(v); });
    ok.addEventListener('click', () => form.requestSubmit());
    modalResolve = resolve;
    openModal(title, form, [el('button', { onclick: () => closeModal(null) }, 'Abbrechen'), ok]);
  });
}

/**
 * Confirmation on its own layer, so it can sit above an open dialog.
 * opts: { title, okLabel, cancelLabel, danger, icon: 'warn'|'question', extra: { label, action } }
 */
function confirmDialog(text, opts = {}) {
  return new Promise((resolve) => {
    const bd = $('#confirm-backdrop');
    const done = (v) => { bd.hidden = true; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(false); } };
    const ok = el('button', { class: opts.danger ? 'danger-solid' : 'primary', onclick: () => done(true) }, opts.okLabel || 'Ja');
    const extra = opts.extra ? el('button', { class: 'link', onclick: () => { done(false); opts.extra.action(); } }, opts.extra.label) : null;
    const buttons = [el('button', { onclick: () => done(false) }, opts.cancelLabel || 'Abbrechen'), ok];
    const card = $('#confirm-card');
    card.className = 'card confirm' + (opts.danger ? ' danger' : '');
    card.textContent = '';
    card.append(
      el('div', { class: 'confirm-icon', html: opts.icon === 'warn' || opts.danger ? ICON.warn : ICON.info }),
      el('div', { class: 'confirm-body' },
        el('h2', {}, opts.title || 'Bist du sicher?'),
        el('p', {}, text),
        extra,
        el('div', { class: 'confirm-buttons' }, buttons)));
    bd.onclick = (e) => { if (e.target === bd) done(false); };
    document.addEventListener('keydown', onKey, true);
    bd.hidden = false;
    setTimeout(() => ok.focus(), 30);
  });
}

function kv(rows) {
  const dl = el('dl', { class: 'kv' });
  for (const [k, v] of rows) if (v != null && v !== '') dl.append(el('dt', {}, k), el('dd', {}, v));
  return dl;
}

function showClientInfo(id) {
  const c = S.clients.get(id);
  if (!c) return;
  const ch = S.channels.get(c.channel);
  const body = el('div', {},
    kv([
      ['Nickname', c.name],
      ['Kanal', ch ? ch.name : '–'],
      ['Eindeutige ID', c.uid ? el('code', {}, c.uid) : null],
      ['Datenbank-ID', String(c.database_id)],
      ['Servergruppen', c.server_groups.join(', ') || '–'],
      ['Kanalgruppe', c.channel_group],
      ['Land', c.country],
      ['Talk Power', String(c.talk_power)],
      ['Abwesend', c.away != null ? (c.away || 'ja') : null],
      ['Version', c.version],
      ['Plattform', c.platform],
      ['Verbunden seit', c.connected_secs != null ? fmtDuration(c.connected_secs) : null],
      ['Untätig seit', c.idle_secs != null ? fmtDuration(c.idle_secs) : null],
      ['Ping', c.ping_ms != null ? c.ping_ms + ' ms' : null],
    ]),
    c.description ? el('p', { html: bbcode(c.description) }) : null);
  openModal(c.name, body, [el('button', { class: 'primary', onclick: () => closeModal() }, 'Schließen')]);
}

function showChannelInfo(id) {
  const ch = S.channels.get(id);
  if (!ch) return;
  send({ t: 'channel_description', channel: id });
  const desc = el('div', { class: 'small' }, el('span', { class: 'muted' }, 'Beschreibung wird geladen…'));
  const body = el('div', {},
    kv([
      ['Name', ch.name],
      ['Thema', ch.topic],
      ['Typ', { permanent: 'Permanent', semi_permanent: 'Semi-permanent', temporary: 'Temporär' }[ch.kind]],
      ['Benutzer', `${clientsIn(id).length}${ch.max_clients >= 0 ? ' / ' + ch.max_clients : ''}`],
      ['Passwort', ch.has_password ? 'ja' : 'nein'],
      ['Codec', `${ch.codec} (Qualität ${ch.codec_quality})`],
      ['Benötigte Talk Power', ch.needed_talk_power ? String(ch.needed_talk_power) : null],
      ['Verschlüsselt', ch.is_unencrypted ? 'nein' : 'ja'],
    ]),
    el('h3', {}, 'Beschreibung'), desc);
  openModal(ch.name, body, [el('button', { class: 'primary', onclick: () => closeModal() }, 'Schließen')]);
  let tries = 0;
  const poll = setInterval(() => {
    const c = S.channels.get(id);
    if (c && c.description != null) {
      desc.innerHTML = c.description ? bbcode(c.description) : '<span class="muted">Keine Beschreibung</span>';
      clearInterval(poll);
    } else if (++tries > 20) { desc.innerHTML = '<span class="muted">Keine Beschreibung verfügbar</span>'; clearInterval(poll); }
  }, 250);
  S.onModalClose = () => clearInterval(poll);
}

function showServerInfo() {
  const s = S.server;
  if (!s) return;
  const users = [...S.clients.values()].filter((c) => !c.is_query).length;
  const body = el('div', {},
    s.hostbanner_gfx_url ? el('a', { href: s.hostbanner_url || s.hostbanner_gfx_url, target: '_blank', rel: 'noopener noreferrer' },
      el('img', { src: s.hostbanner_gfx_url, alt: '', style: 'max-width:100%;border-radius:8px;margin-bottom:8px' })) : null,
    kv([
      ['Name', s.name],
      ['Adresse', S.config.allow_any_server ? (S.connParams.address || S.config.server) : S.config.server],
      ['Benutzer', `${users} / ${s.max_clients}`],
      ['Kanäle', String(S.channels.size)],
      ['Version', s.version],
      ['Plattform', s.platform],
      ['Deine ID', S.identity ? el('code', {}, S.identity.uid) : null],
    ]),
    s.welcome_message ? el('div', {}, el('h3', {}, 'Willkommensnachricht'), el('p', { html: bbcode(s.welcome_message) })) : null);
  openModal('Serverinfo', body, [el('button', { onclick: () => openManage('server') }, 'Server verwalten'), el('button', { class: 'primary', onclick: () => closeModal() }, 'Schließen')]);
}

function channelForm(ch = {}) {
  const f = (name, label, val = '', type = 'text') => {
    const i = el('input', { name, type });
    i.value = val ?? '';
    return el('label', {}, label, i);
  };
  const form = el('form', {},
    f('name', 'Name', ch.name),
    f('topic', 'Thema', ch.topic),
    el('label', {}, 'Beschreibung', Object.assign(el('textarea', { name: 'description', rows: 3 }), { value: ch.description || '' })),
    f('password', 'Passwort (optional)', '', 'password'));
  form.append(el('label', {}, 'Typ', el('select', { name: 'kind' },
    el('option', { value: 'temporary' }, 'Temporär (wird gelöscht, wenn leer)'),
    el('option', { value: 'semi_permanent' }, 'Semi-permanent'),
    el('option', { value: 'permanent' }, 'Permanent'))));
  form.append(f('max_clients', 'Max. Benutzer (0 = unbegrenzt)', '0', 'number'));
  form.append(el('p', { class: 'muted small' }, 'Codec, Talk Power und weitere Einstellungen gibt es nach dem Erstellen unter „Kanal bearbeiten“.'));
  return form;
}

function createChannelDialog(parent = 0) {
  const form = channelForm();
  const ok = el('button', { class: 'primary', type: 'button' }, 'Erstellen');
  ok.addEventListener('click', () => {
    const d = Object.fromEntries(new FormData(form));
    if (!d.name.trim()) return;
    send({ t: 'create_channel', name: d.name, parent, password: d.password, topic: d.topic, description: d.description, kind: d.kind, max_clients: Number(d.max_clients) || null });
    closeModal();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); ok.click(); });
  openModal(parent ? `Unterkanal von „${S.channels.get(parent)?.name}“` : 'Kanal erstellen', form, [el('button', { onclick: () => closeModal() }, 'Abbrechen'), ok]);
}

// ---------------------------------------------------------------- chat
function addMsg(tabKey, msg) {
  let tab = S.tabs.get(tabKey);
  if (!tab) return;
  if (msg.from && !msg.sys) {
    // plain text of the last message for the mini window (DOMParser does not run anything)
    S.miniLast = `${msg.from}: ${msg.text != null ? msg.text : (new DOMParser().parseFromString(msg.html || '', 'text/html').body.textContent || '')}`;
    if (S.mini) renderMini();
  }
  msg.time = msg.time || new Date();
  tab.msgs.push(msg);
  if (tab.msgs.length > 500) tab.msgs.shift();
  if (tabKey === S.activeTab && !$('#app').hidden) {
    const log = $('#chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(renderMsg(msg));
    if (atBottom || msg.self) log.scrollTop = log.scrollHeight;
  } else if (!msg.sys) {
    // only real messages count as unread, not events (joins, leaves, …)
    if (!tab.quiet) { tab.unread++; renderTabs(); }
  }
  updateMobileBadge();
}

function renderMsg(m) {
  const d = el('div', { class: 'msg' + (m.sys ? ' sys' : '') + (m.cls ? ' ' + m.cls : '') + (m.self ? ' me' : '') });
  d.append(el('span', { class: 'time' }, fmtTime(m.time)));
  if (m.from) {
    const from = el('span', { class: 'from' }, m.from + ':');
    if (m.fromId != null && m.fromId !== S.ownId) {
      from.style.cursor = 'pointer';
      from.addEventListener('click', (e) => { const c = S.clients.get(m.fromId); if (c) clientMenu(c, e); });
    }
    d.append(from);
  }
  const body = el('span');
  if (m.html) body.innerHTML = m.html; else body.textContent = m.text;
  d.append(body);
  return d;
}

function renderTabs() {
  const bar = $('#chat-tabs');
  bar.textContent = '';
  for (const [key, tab] of S.tabs) {
    const b = el('button', { class: key === S.activeTab ? 'active' : '', onclick: () => switchTab(key) }, tab.title);
    if (tab.unread) b.append(el('span', { class: 'badge' }, tab.unread));
    if (tab.closable) {
      const x = el('span', { class: 'close', title: 'Schließen' }, '✕');
      x.addEventListener('click', (e) => { e.stopPropagation(); S.tabs.delete(key); historyHide(key); if (S.activeTab === key) switchTab('server'); else renderTabs(); });
      b.append(x);
    }
    bar.append(b);
  }
  const ct = $('#chat-text');
  const tab = S.tabs.get(S.activeTab);
  ct.placeholder = `Nachricht an ${tab ? tab.title : ''}…`;
}

function switchTab(key) {
  if (!S.tabs.has(key)) return;
  S.activeTab = key;
  const tab = S.tabs.get(key);
  tab.unread = 0;
  const log = $('#chat-log');
  log.textContent = '';
  for (const m of tab.msgs) log.append(renderMsg(m));
  log.scrollTop = log.scrollHeight;
  renderTabs();
  updateMobileBadge();
}

/** Key of a private chat: by unique id, so it stays the same after reconnecting. */
function pmKey(clientId) {
  const c = S.clients.get(clientId);
  return 'pm:' + (c && c.uid ? c.uid : '#' + clientId);
}

function openPrivate(clientId, focus = true) {
  const key = pmKey(clientId);
  const c = S.clients.get(clientId);
  if (!S.tabs.has(key)) {
    S.tabs.set(key, { title: c ? c.name : '#' + clientId, msgs: historyMsgs(key), unread: 0, closable: true, clientId, uid: c && c.uid });
  } else {
    const t = S.tabs.get(key);
    t.clientId = clientId;
    if (c) t.title = c.name;
  }
  if (focus) {
    switchTab(key);
    showPane('chat');
    $('#chat-text').focus();
  } else renderTabs();
  return key;
}

function onChat(m) {
  const self = m.from_id === S.ownId;
  let key = m.target;
  let histKey = m.target;
  let histName = '';
  if (m.target === 'private') {
    key = openPrivate(m.partner, false);
    histKey = key;
    histName = S.tabs.get(key).title;
  } else if (m.target === 'channel') {
    const ch = S.clients.get(S.ownId)?.channel;
    histKey = ch != null ? 'ch:' + ch : null;
    histName = S.channels.get(ch)?.name || '';
  }
  addMsg(key, { from: m.from_name, fromId: m.from_id, html: bbcode(m.text), self });
  if (histKey && !histKey.includes('#')) historyRecord(histKey, histName, { t: Date.now(), f: m.from_name, u: m.from_uid || '', s: self ? 1 : 0, x: m.text });
  if (!self) {
    sound(m.target === 'private' ? 'pm' : 'message');
    if (m.target === 'private') notify(`Nachricht von ${m.from_name}`, m.text);
  }
}

function onPoke(m) {
  sound('poke');
  notify(`${m.from_name} stupst dich an`, m.text);
  toast(`${m.from_name} stupst dich an${m.text ? ': ' + m.text : ''}`, 'poke');
  addMsg(S.activeTab, { sys: true, cls: 'poke', text: `${m.from_name} stupst dich an: ${m.text}` });
  const body = el('div', {}, el('p', { class: 'muted' }, `${m.from_name} hat dich angestupst:`), el('p', { class: 'poke-text', html: bbcode(m.text) }));
  openModal('Poke', body, [
    el('button', { onclick: () => { closeModal(); openPrivate(m.from_id); } }, 'Antworten'),
    el('button', { class: 'primary', onclick: () => closeModal() }, 'OK'),
  ]);
}

/** Server events go to the server chat (joins/leaves only if enabled in the settings). */
function onLog(m) {
  const own = S.clients.get(S.ownId);
  if (m.kind === 'kick' && own && m.text.startsWith(own.name + ' ')) S.channelKickAt = Date.now();
  const joinLeave = m.kind === 'join' || m.kind === 'leave' || m.kind === 'move' || m.kind === 'kick';
  if (joinLeave && !settings.joinLeave) return;
  addMsg('server', { sys: true, cls: m.kind, text: m.text });
}

function updateMobileBadge() {
  let n = 0;
  for (const t of S.tabs.values()) if (!t.quiet) n += t.unread;
  const b = $('#mobile-chat-badge');
  b.textContent = n;
  b.hidden = !n || $('#pane-chat').classList.contains('active');
}

// ---------------------------------------------------------------- chat history
// Server, channel and private chats stay after reconnecting: at most 500 messages
// per chat, no time limit. The browser derives an id, a token and a key from the
// TeamSpeak identity (HKDF, per server), compresses and encrypts the history; the bridge
// only stores the encrypted data and cannot read it. Chats of channels that no
// longer exist are deleted.
const HIST_MAX = 500;
const newHistory = () => ({ keys: null, data: null, version: 0, loaded: false, loading: false, timer: null, saving: false, again: false, pending: [], channel: null });
let H = newHistory();

function historyOn() { return !!(S.config && S.config.history && settings.history && window.isSecureContext && crypto.subtle); }
function historyServer() {
  const a = S.config.allow_any_server && S.connParams && S.connParams.address ? S.connParams.address : S.config.server;
  return String(a || '').trim().toLowerCase();
}

async function historyKeys(identity, server) {
  const base = await crypto.subtle.importKey('raw', te.encode(identity), 'HKDF', false, ['deriveBits']);
  const salt = te.encode('ts3-webbridge history v1\n' + server);
  const bits = async (info) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, base, 256));
  return { vault: toHex(await bits('id')), auth: toHex(await bits('auth')), key: toB64(await bits('key')) };
}

async function historyEncrypt(keys, data) {
  let body = te.encode(JSON.stringify(data));
  let flag = 0;
  if ('CompressionStream' in window) {
    body = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    flag = 1;
  }
  const plain = new Uint8Array(body.length + 1);
  plain[0] = flag;
  plain.set(body, 1);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await syncKey(keys), plain));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  return toB64(all);
}

async function historyDecrypt(keys, blob) {
  const all = fromB64(blob);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await syncKey(keys), all.slice(12)));
  let body = plain.slice(1);
  if (plain[0] === 1) body = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const d = JSON.parse(new TextDecoder().decode(body));
  d.chats = d.chats || {};
  return d;
}

async function historyApi(action, body) {
  const q = S.config.needs_access_password ? '?key=' + encodeURIComponent(accessKey()) : '';
  const res = await fetch('api/history/' + action + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

/** Combine two histories (several tabs or devices): all messages, at most 500 per chat. */
function historyMerge(local, remote) {
  const out = { v: 1, chats: {} };
  for (const k of new Set([...Object.keys(remote.chats), ...Object.keys(local.chats)])) {
    const a = local.chats[k];
    const b = remote.chats[k];
    const seen = new Set();
    const m = [...(b ? b.m : []), ...(a ? a.m : [])].filter((x) => {
      const id = `${x.t}|${x.u}|${x.s}|${x.x}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).sort((x, y) => x.t - y.t).slice(-HIST_MAX);
    const c = { m };
    const name = (a && a.n) || (b && b.n);
    if (name) c.n = name;
    if ((a ? a.h : b && b.h)) c.h = 1;
    out.chats[k] = c;
  }
  return out;
}

/** Stored messages of a chat, as chat lines (with a separator at the end). */
function historyMsgs(key) {
  const c = H.loaded && H.data.chats[key];
  if (!c || !c.m.length) return [];
  const msgs = c.m.map((h) => {
    const other = h.u ? [...S.clients.values()].find((x) => x.uid === h.u) : null;
    return { from: h.f, fromId: h.s ? S.ownId : (other ? other.id : null), html: bbcode(h.x), self: !!h.s, time: new Date(h.t), hist: true };
  });
  msgs.push({ sys: true, cls: 'hist', text: '— Ende des gespeicherten Verlaufs —' });
  return msgs;
}

function historyRecord(key, name, msg) {
  if (!historyOn()) return;
  if (!H.loaded) { H.pending.push([key, name, msg]); return; }
  const c = H.data.chats[key] || (H.data.chats[key] = { m: [] });
  if (name) c.n = name;
  delete c.h;
  c.m.push(msg);
  if (c.m.length > HIST_MAX) c.m.splice(0, c.m.length - HIST_MAX);
  historySaveSoon();
}

function historyHide(key) {
  if (!H.loaded || !H.data.chats[key]) return;
  H.data.chats[key].h = 1;
  historySaveSoon();
}

/** Load after connecting and put the stored messages into the chats. */
async function historyStart() {
  if (!historyOn() || !S.identity || H.loaded || H.loading) return;
  const h = H;
  h.loading = true;
  try {
    h.keys = await historyKeys(S.identity.identity, historyServer());
    const r = await historyApi('load', { vault: h.keys.vault, auth: h.keys.auth });
    if (r.status === 404) { h.data = { v: 1, chats: {} }; h.version = 0; }
    else if (r.status === 200) { h.data = await historyDecrypt(h.keys, r.data.blob); h.version = r.data.version; }
    else throw new Error(r.data.error || `Fehler ${r.status}`);
    if (h !== H) return; // left meanwhile
    h.loaded = true;
    historyShow();
    // messages that came in while loading are on screen already
    for (const [k, n, m] of h.pending.splice(0)) historyRecord(k, n, m);
    historyCleanup();
  } catch (e) {
    console.warn('Chatverlauf nicht geladen', e);
  } finally {
    h.loading = false;
  }
}

function historyShow() {
  const server = S.tabs.get('server');
  if (server) server.msgs = [...historyMsgs('server'), ...server.msgs];
  const ch = S.clients.get(S.ownId)?.channel;
  const chTab = S.tabs.get('channel');
  if (chTab && ch != null) { chTab.msgs = [...historyMsgs('ch:' + ch), ...chTab.msgs]; H.channel = ch; }
  for (const [key, c] of Object.entries(H.data.chats)) {
    if (!key.startsWith('pm:') || c.h || !c.m.length) continue;
    const uid = key.slice(3);
    if (S.tabs.has(key)) { S.tabs.get(key).msgs = [...historyMsgs(key), ...S.tabs.get(key).msgs]; continue; }
    const other = [...S.clients.values()].find((x) => x.uid === uid);
    S.tabs.set(key, { title: other ? other.name : `${c.n || uid} (offline)`, msgs: historyMsgs(key), unread: 0, closable: true, clientId: other ? other.id : null, uid });
  }
  if (!$('#app').hidden) switchTab(S.tabs.has(S.activeTab) ? S.activeTab : 'channel');
}

/** After every state: channel chat follows your channel, chats of deleted channels go away. */
function historyOnState() {
  if (!H.loaded) return;
  historyCleanup();
  const ch = S.clients.get(S.ownId)?.channel;
  if (ch == null || ch === H.channel) return;
  H.channel = ch;
  const tab = S.tabs.get('channel');
  if (!tab) return;
  tab.msgs = historyMsgs('ch:' + ch);
  if (S.activeTab === 'channel' && !$('#app').hidden) switchTab('channel');
}

function historyCleanup() {
  if (!H.loaded || !S.channels.size) return;
  let changed = false;
  for (const key of Object.keys(H.data.chats)) {
    if (key.startsWith('ch:') && !S.channels.has(Number(key.slice(3)))) {
      delete H.data.chats[key];
      changed = true;
    }
  }
  if (changed) historySaveSoon();
}

function historySaveSoon() {
  clearTimeout(H.timer);
  H.timer = setTimeout(() => { H.timer = null; historySave(H); }, 4000);
}

async function historySave(h) {
  if (!h.loaded || !h.keys) return;
  if (h.saving) { h.again = true; return; }
  h.saving = true;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await historyApi('save', { vault: h.keys.vault, auth: h.keys.auth, version: h.version, blob: await historyEncrypt(h.keys, h.data) });
      if (r.status === 200) { h.version = r.data.version; return; }
      if (r.status !== 409) throw new Error(r.data.error || `Fehler ${r.status}`);
      // changed in another tab or on another device: merge and try again
      let remote = r.data.blob ? { blob: r.data.blob, version: r.data.version } : null;
      if (!remote) {
        const l = await historyApi('load', { vault: h.keys.vault, auth: h.keys.auth });
        if (l.status !== 200) continue;
        remote = l.data;
      }
      h.data = historyMerge(h.data, await historyDecrypt(h.keys, remote.blob));
      h.version = remote.version;
    }
  } catch (e) {
    console.warn('Chatverlauf nicht gespeichert', e);
  } finally {
    h.saving = false;
    if (h.again) { h.again = false; historySave(h); }
  }
}

/** Leaving: save what is still open, then start fresh (next identity/server). */
function historyStop() {
  const h = H;
  if (h.timer) { clearTimeout(h.timer); h.timer = null; historySave(h); }
  H = newHistory();
}

/** "Delete stored chat history" in the settings (for the active identity and server). */
async function historyDelete() {
  const id = (S.status === 'connected' && S.identity) || activeIdentity();
  if (!id || !S.config || !S.config.history) return;
  try {
    const keys = H.keys || await historyKeys(id.identity, historyServer());
    const r = await historyApi('delete', { vault: keys.vault, auth: keys.auth });
    if (r.status !== 200) throw new Error(r.data.error || `Fehler ${r.status}`);
    if (H.loaded) { H.data = { v: 1, chats: {} }; H.version = 0; }
    toast('Gespeicherter Chatverlauf gelöscht');
  } catch (e) {
    toast('Löschen fehlgeschlagen: ' + e.message, 'error');
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && H.timer) { clearTimeout(H.timer); H.timer = null; historySave(H); }
});

// ---------------------------------------------------------------- audio
/** Noise filter model: 'strong' (RNNoise 0.2, better) or 'light' (small, for slow devices). */
async function loadFilter(kind) {
  try {
    const res = await fetch(kind === 'light' ? 'rnnoise.wasm' : 'rnnoise-v2.wasm');
    if (!res.ok) throw new Error(res.status);
    S.rnnKind = kind;
    return await res.arrayBuffer();
  } catch (e) {
    console.warn('Rauschfilter nicht verfügbar', kind, e);
    return kind === 'strong' ? loadFilter('light') : null;
  }
}

/** Reports from the microphone processing (about once per second). */
async function onMicDiag(d) {
  S.micDiag = d;
  // Too slow for the strong filter (more than 30 % of the time budget): switch to the light one.
  if (d.model === 'strong' && d.filterMs != null && d.filterMs > 6 && !S.switchingFilter) {
    S.switchingFilter = true;
    settings.lightFilter = true; saveSettings();
    const bytes = await loadFilter('light');
    if (bytes) { S.rnnBytes = bytes; S.captureNode && S.captureNode.port.postMessage({ rnnoise: bytes.slice(0) }); }
    toast('Dein Gerät ist für den starken Rauschfilter zu langsam – der leichte Filter ist jetzt aktiv.');
    S.switchingFilter = false;
  }
  // Remember problems for a while, warn once per session when connected.
  const issue = micIssue(d);
  if (issue && issue.warn) {
    S.micIssueCount = (S.micIssueCount || 0) + 1;
    if (S.micIssueCount === 4 && S.status === 'connected' && !S.micIssueWarned) { S.micIssueWarned = true; toast(issue.text, 'error'); }
  } else if (d.speechFrames > 10) S.micIssueCount = 0;
  updateMicCheck();
}

/** What is wrong with the microphone, if anything (based on the last report). */
function micIssue(d) {
  if (!d || !settings.denoise) return null;
  if (d.speechFrames < 10) return null;
  if (d.clipRatio > 0.1) return { warn: true, text: 'Dein Mikrofon übersteuert (zu laut eingestellt) und klingt dadurch verzerrt. Stelle es in den Sound-Einstellungen deines Computers leiser.' };
  if (d.rawSpeechDb != null && d.rawSpeechDb < -40) return { warn: true, text: settings.autoLevel
    ? 'Dein Mikrofon ist sehr leise eingestellt. Die Brücke gleicht das aus – noch besser klingt es, wenn du es in den Sound-Einstellungen deines Computers lauter stellst.'
    : 'Dein Mikrofon ist sehr leise. Stelle es in den Sound-Einstellungen lauter oder schalte „Lautstärke automatisch angleichen“ ein.' };
  return { warn: false, text: '✓ Dein Mikrofon klingt gut.' };
}

function updateMicCheck() {
  const box = $('#s-mic-check');
  if (!box) return;
  const d = S.micDiag;
  const filter = !settings.denoise ? 'Rauschfilter aus' : !d || !d.model ? 'Rauschfilter wird geladen…'
    : d.model === 'strong' ? 'Rauschfilter: stark' : 'Rauschfilter: leicht' + (settings.lightFilter ? ' (Gerät zu langsam für den starken)' : '');
  const issue = micIssue(d);
  box.className = 'mic-check' + (issue && issue.warn ? ' warn' : issue ? ' ok' : '');
  box.textContent = '';
  box.append(el('div', {}, issue ? issue.text : (settings.denoise ? 'Sag etwas – dann prüft die Brücke dein Mikrofon.' : 'Für den Mikrofon-Check muss der KI-Rauschfilter an sein.')),
    el('div', { class: 'small muted' }, filter));
}

async function setupAudio() {
  await detectOpus();
  if (!S.rnnBytes) S.rnnBytes = await loadFilter(settings.lightFilter ? 'light' : 'strong');
  if (!S.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    try { S.ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' }); } catch { S.ctx = new Ctx({ latencyHint: 'interactive' }); }
    await S.ctx.audioWorklet.addModule('audio-worklet.js');
    S.playbackNode = new AudioWorkletNode(S.ctx, 'playback-processor', { numberOfInputs: 0, outputChannelCount: [2] });
    S.outGain = S.ctx.createGain();
    S.outGain.gain.value = settings.volume / 100;
    // Everything that is played (voices, notification sounds, mic test) goes
    // through this bus, so the chosen output device applies to all of it.
    S.outBus = S.ctx.createGain();
    S.outBus.connect(S.ctx.destination);
    S.playbackNode.connect(S.outGain).connect(S.outBus);
    applyOutputDevice();
  }
  if (S.ctx.state === 'suspended') await S.ctx.resume().catch(() => {});
  await startMic();
}

/**
 * How this browser can choose the speaker:
 * 'context' – AudioContext.setSinkId (Chrome, Edge, Opera on the desktop),
 * 'element' – only an <audio> element can (Firefox; devices are picked with
 *             selectAudioOutput), the audio is routed through one then,
 * 'none'    – the system decides (iPhone/iPad, most phone browsers).
 */
function sinkSupport() {
  const ctx = S.ctx || window.AudioContext || window.webkitAudioContext;
  const proto = ctx && (ctx.prototype || Object.getPrototypeOf(ctx));
  if (proto && typeof proto.setSinkId === 'function') return 'context';
  if (typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId === 'function') return 'element';
  return 'none';
}

async function applyOutputDevice() {
  if (!S.ctx || !S.outBus) return;
  const id = settings.outputDevice || '';
  const mode = sinkSupport();
  const fail = (e) => {
    console.warn('setSinkId', e);
    toast('Das gewählte Ausgabegerät ist nicht verfügbar – es wird das Standardgerät benutzt.', 'error');
    settings.outputDevice = '';
    saveSettings();
  };
  if (mode === 'context') {
    try { await S.ctx.setSinkId(id); } catch (e) { fail(e); try { await S.ctx.setSinkId(''); } catch { /* ignore */ } }
    return;
  }
  if (mode !== 'element') return;
  // Firefox: an <audio> element plays the mix on the chosen device.
  S.outBus.disconnect();
  if (!id) {
    if (S.outEl) S.outEl.pause();
    S.outBus.connect(S.ctx.destination);
    return;
  }
  if (!S.outEl) {
    S.outDest = S.ctx.createMediaStreamDestination();
    S.outEl = new Audio();
    S.outEl.srcObject = S.outDest.stream;
  }
  try {
    await S.outEl.setSinkId(id);
    S.outBus.connect(S.outDest);
    await S.outEl.play();
  } catch (e) {
    fail(e);
    S.outBus.disconnect();
    S.outBus.connect(S.ctx.destination);
  }
}

// Readable device names. Phones and some browsers list the same device several
// times (Chrome's "default"/"communications" aliases, Android's "Standard").
const DEVICE_NAMES = [
  [/^speakerphone$/i, { audioinput: 'Mikrofon (Freisprechen)', audiooutput: 'Lautsprecher' }],
  [/^headset earpiece$/i, { audioinput: 'Mikrofon (am Ohr)', audiooutput: 'Hörmuschel' }],
  [/^(built-?in|integrierte?s?) (microphone|mikrofon)$/i, 'Eingebautes Mikrofon'],
  [/^bottom microphone$/i, 'Mikrofon unten'],
  [/^back microphone$/i, 'Mikrofon hinten'],
  [/^front microphone$/i, 'Mikrofon vorne'],
  [/^wired headset$/i, 'Kabel-Headset'],
  [/^usb (audio|headset)$/i, 'USB-Headset'],
];

function deviceList(devs, kind) {
  const generic = kind === 'audioinput' ? 'Mikrofon' : 'Ausgang';
  const isDefaultName = (l) => /^(standard|default|standardgerät)$/i.test(l.trim());
  let defaultName = '';
  const seen = new Set();
  const out = [];
  for (const d of devs.filter((x) => x.kind === kind)) {
    let label = (d.label || '').trim();
    if (d.deviceId === 'default' || d.deviceId === 'communications' || !d.deviceId) {
      // Chrome: "Standard - Realtek Audio" – shown in the "Standard" entry
      if (d.deviceId === 'default') defaultName = label.replace(/^(standard|default)\s*[-–:]\s*/i, '');
      continue;
    }
    if (isDefaultName(label)) continue;
    for (const [re, name] of DEVICE_NAMES) if (re.test(label)) { label = typeof name === 'string' ? name : name[kind]; break; }
    const key = (d.groupId || '') + '|' + label;
    if (label && seen.has(key)) continue;
    seen.add(key);
    out.push({ id: d.deviceId, label });
  }
  // unnamed devices get numbers, equal names a counter
  let n = 0;
  const count = new Map();
  for (const o of out) {
    if (!o.label) o.label = `${generic} ${++n}`;
    const c = (count.get(o.label) || 0) + 1;
    count.set(o.label, c);
    if (c > 1) o.label += ` (${c})`;
  }
  return { defaultName: isDefaultName(defaultName) ? '' : defaultName, list: out };
}

async function startMic() {
  stopMic();
  if (!S.ctx) return; // audio is set up on connect (or when the settings are opened)
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    S.micError = 'Mikrofon nicht verfügbar (HTTPS nötig)';
    updateTxState();
    return;
  }
  try {
    S.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: settings.inputDevice ? { exact: settings.inputDevice } : undefined,
        echoCancellation: settings.echo, noiseSuppression: settings.noise, autoGainControl: settings.agc,
        channelCount: 1,
      },
    });
  } catch (e) {
    if (settings.inputDevice) { settings.inputDevice = ''; saveSettings(); return startMic(); }
    S.micError = e.name === 'NotAllowedError' ? 'Mikrofonzugriff verweigert – nur Zuhören möglich' : 'Kein Mikrofon gefunden – nur Zuhören möglich';
    toast(S.micError, 'error');
    updateTxState();
    return;
  }
  S.micError = null;
  S.autoFrames = 0; S.autoRun = 0; S.noiseFloor = null;
  S.micSource = S.ctx.createMediaStreamSource(S.micStream);
  S.captureNode = new AudioWorkletNode(S.ctx, 'capture-processor', { numberOfOutputs: 0 });
  S.captureNode.port.postMessage({ gain: settings.gain / 100, denoise: settings.denoise, autoLevel: settings.autoLevel, rnnoise: S.rnnBytes ? S.rnnBytes.slice(0) : null });
  S.captureNode.port.onmessage = (e) => {
    if (e.data.frame) onMicFrame(e.data.frame, e.data.rms, e.data.vad);
    else if (e.data.diag) onMicDiag(e.data.diag);
    else if (e.data.denoiserError) console.warn('RNNoise failed', e.data.denoiserError);
  };
  S.micSource.connect(S.captureNode);
  updateTxState();
}

function stopMic() {
  stopTransmit();
  if (S.micSource) { try { S.micSource.disconnect(); } catch { /* ignore */ } S.micSource = null; }
  if (S.captureNode) { S.captureNode.port.onmessage = null; S.captureNode = null; }
  if (S.micStream) { S.micStream.getTracks().forEach((t) => t.stop()); S.micStream = null; }
}

/**
 * Automatic voice activation: no threshold to set. With the noise filter it
 * opens when the filter hears speech; without it, when the level is clearly
 * above the room noise (tracked continuously).
 */
function autoVoice(db, vad) {
  // the filter needs about half a second to settle after the microphone starts
  S.autoFrames = (S.autoFrames || 0) + 1;
  if (S.autoFrames < 25) return false;
  // background noise: follows quiet moments quickly, loud ones slowly
  S.noiseFloor = S.noiseFloor == null ? db : db < S.noiseFloor ? S.noiseFloor + 0.3 * (db - S.noiseFloor) : S.noiseFloor + 0.01 * (db - S.noiseFloor);
  const hit = vad >= 0 ? vad >= 0.7 && db > -62 : db > Math.max(S.noiseFloor + 10, -55);
  S.autoRun = hit ? (S.autoRun || 0) + 1 : 0;
  // open after 40 ms of speech (single noisy frames do not count); while open,
  // a lower speech probability is enough to stay open
  const speech = S.autoRun >= 2 || (S.vadHang > 0 && vad >= 0.42);
  if (speech) { S.vadHang = 15; return true; } // keep open 300 ms after speech
  if (S.vadHang > 0) { S.vadHang--; return true; }
  return false;
}

function onMicFrame(frame, rms, vad = -1) {
  S.lastRms = rms;
  const db = linToDb(rms);
  let want = false;
  if (settings.mode === 'continuous') want = true;
  else if (settings.mode === 'ptt') want = S.pttDown;
  else if (settings.mode === 'auto') want = autoVoice(db, vad);
  else {
    // With the noise filter, loud noise that is not speech (typing, clicks) does not open the mic.
    const speech = vad < 0 || vad >= 0.5;
    if (db >= settings.vadDb && speech) { want = true; S.vadHang = 15; } // 300 ms hangover
    else if (S.vadHang > 0) { S.vadHang--; want = true; }
  }
  S.voiceActive = want;
  if (S.testRec) S.testRec.push(want ? frame.slice(0) : new Float32Array(frame.length));
  const canSend = S.status === 'connected' && !S.inputMuted && !S.outputMuted && !S.away && S.canTalk !== false && S.ws && S.ws.readyState === 1;
  if (want && canSend) {
    if (!S.transmitting) {
      S.transmitting = true;
      updateTalking();
      updateTxState();
      // send a bit of pre-roll so the first syllable is not cut off (VAD)
      if (settings.mode === 'vad') for (const p of S.preroll) sendFrame(p);
    }
    sendFrame(frame);
    S.preroll = [];
  } else {
    if (S.transmitting) stopTransmit();
    S.preroll.push(frame);
    if (S.preroll.length > 2) S.preroll.shift();
  }
}

function sendFrame(frame) {
  if (S.encoder) {
    try {
      const data = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: frame.length, numberOfChannels: 1, timestamp: S.encTs, data: frame });
      S.encTs += 20000;
      S.encoder.encode(data);
      data.close();
      return;
    } catch (e) {
      console.warn('Opus encoder failed, falling back to PCM', e);
      closeEncoder();
    }
  }
  const pcm = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(frame[i] * 32767)));
  if (S.ws.bufferedAmount < 64 * 1024) S.ws.send(pcm.buffer);
}

function stopTransmit() {
  if (!S.transmitting) return;
  S.transmitting = false;
  const ws = S.ws;
  const end = () => { if (ws && ws.readyState === 1) ws.send(new ArrayBuffer(0)); };
  // With Opus the last packets may still be in the encoder: send them first.
  if (S.encoder) S.encoder.flush().then(end, end);
  else end();
  updateTalking();
  updateTxState();
}

// meter animation
function meterLoop() {
  const db = linToDb(S.lastRms);
  const pct = Math.max(0, Math.min(100, ((db + 70) / 60) * 100));
  const th = Math.max(0, Math.min(100, ((settings.vadDb + 70) / 60) * 100));
  for (const [m, t] of [['#mic-meter', '#mic-threshold'], ['#s-meter', '#s-meter-threshold']]) {
    const me = $(m), te = $(t);
    if (me) me.style.width = pct + '%';
    if (te) { te.style.left = th + '%'; te.hidden = settings.mode !== 'vad'; }
    if (me) me.classList.toggle('on', !!S.voiceActive); // green = you would be heard
  }
  S.lastRms *= 0.9;
  requestAnimationFrame(meterLoop);
}

function updateTxState() {
  const t = $('#tx-state');
  let text = '';
  if (S.micError) text = S.micError;
  else if (S.inputMuted) text = 'Mikrofon stumm';
  else if (S.away) text = 'Abwesend – du wirst nicht übertragen';
  else if (!S.canTalk) text = 'Du darfst in diesem Kanal nicht sprechen';
  else if (S.transmitting) text = 'Sendet…';
  else text = { auto: 'Sprachaktivierung (automatisch)', vad: 'Sprachaktivierung', ptt: `Push-to-Talk (${keyLabel(settings.keys.ptt)})`, continuous: 'Dauerhaft senden' }[settings.mode];
  t.textContent = text;
  $('#ptt-button').hidden = settings.mode !== 'ptt' || !!S.micError;
  if (S.mini) { const f = S.mini.document.querySelector('.mini-foot > .muted'); if (f) f.textContent = text; }
}

function updateToolbar() {
  const mic = $('#btn-mic');
  mic.innerHTML = S.inputMuted ? ICON.micOff : ICON.mic;
  mic.classList.toggle('active', S.inputMuted);
  mic.title = S.inputMuted ? 'Mikrofon an (M)' : 'Mikrofon stummschalten (M)';
  const spk = $('#btn-speaker');
  spk.innerHTML = S.outputMuted ? ICON.speakerOff : ICON.speaker;
  spk.classList.toggle('active', S.outputMuted);
  spk.title = S.outputMuted ? 'Lautsprecher an (L)' : 'Lautsprecher stummschalten (L)';
  const away = $('#btn-away');
  away.classList.toggle('on', S.away);
  away.title = S.away ? 'Wieder da' : 'Abwesend setzen';
  if (S.mini) renderMini();
}

function toggleInputMute() {
  S.inputMuted = !S.inputMuted;
  if (S.inputMuted) stopTransmit();
  send({ t: 'set_mute', input: S.inputMuted });
  sound(S.inputMuted ? 'mic_off' : 'mic_on');
  updateToolbar(); updateTxState();
}
function toggleOutputMute() {
  S.outputMuted = !S.outputMuted;
  if (S.outputMuted) {
    stopTransmit();
    S.playbackNode && S.playbackNode.port.postMessage({ reset: true });
    if ('speechSynthesis' in window) speechSynthesis.cancel(); // stop a running announcement
  }
  send({ t: 'set_mute', output: S.outputMuted });
  sound(S.outputMuted ? 'sound_off' : 'sound_on');
  updateToolbar(); updateTxState();
}
function toggleAway() {
  if (S.away) { send({ t: 'set_away', away: false }); S.away = false; updateToolbar(); sound('back'); return; }
  promptDialog('Abwesend', '', { label: 'Abwesenheitsnachricht (optional)' }).then((msg) => {
    if (msg == null) return;
    send({ t: 'set_away', away: true, message: msg });
    S.away = true;
    sound('away');
    updateToolbar();
  });
}

// ---------------------------------------------------------------- hotkeys
// A binding is { code, ctrl, alt, shift, meta } for the keyboard (code = physical
// key, so it does not depend on the keyboard layout) or { mouse: n } for mouse
// buttons 3-5 (middle and side buttons). Hotkeys only work while this tab has focus.
const MOD_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']);
const KEY_NAMES = {
  Space: 'Leertaste', Enter: 'Enter', Tab: 'Tab', Backspace: 'Rücktaste', Escape: 'Esc', CapsLock: 'Feststelltaste',
  ControlLeft: 'Strg links', ControlRight: 'Strg rechts', AltLeft: 'Alt', AltRight: 'Alt Gr', ShiftLeft: 'Umschalt links',
  ShiftRight: 'Umschalt rechts', MetaLeft: 'Windows-Taste', MetaRight: 'Windows-Taste rechts',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Insert: 'Einfg', Delete: 'Entf', Home: 'Pos1', End: 'Ende',
  PageUp: 'Bild ↑', PageDown: 'Bild ↓', Backquote: '^', Minus: 'ß', Equal: '´', BracketLeft: 'Ü', BracketRight: '+',
  Semicolon: 'Ö', Quote: 'Ä', Backslash: '#', Comma: ',', Period: '.', Slash: '-', IntlBackslash: '<',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadEnter: 'Num Enter', NumpadDecimal: 'Num ,',
};
const MOUSE_NAMES = { 1: 'Mittlere Maustaste', 3: 'Maus-Seitentaste (zurück)', 4: 'Maus-Seitentaste (vor)' };

if (navigator.keyboard && navigator.keyboard.getLayoutMap) navigator.keyboard.getLayoutMap().then((m) => { S.layoutMap = m; }).catch(() => {});

function keyLabel(b) {
  if (!b) return '–';
  if (b.mouse != null) return MOUSE_NAMES[b.mouse] || `Maustaste ${b.mouse + 1}`;
  const c = b.code;
  // The real layout if the browser tells it (Chrome/Edge), otherwise German.
  const fromLayout = S.layoutMap && /^(Key|Digit|Backquote|Minus|Equal|Bracket|Semicolon|Quote|Backslash|Comma|Period|Slash|IntlBackslash)/.test(c) && S.layoutMap.get(c);
  let name = (fromLayout && fromLayout.toUpperCase())
    || (c === 'KeyY' ? 'Z' : c === 'KeyZ' ? 'Y' : '') // German keyboard: Y and Z are swapped
    || KEY_NAMES[c]
    || (/^Key[A-Z]$/.test(c) && c.slice(3))
    || (/^Digit\d$/.test(c) && c.slice(5))
    || (/^Numpad\d$/.test(c) && 'Num ' + c.slice(6))
    || (/^F\d+$/.test(c) && c)
    || c;
  const mods = [b.ctrl && 'Strg', b.alt && 'Alt', b.shift && 'Umschalt', b.meta && 'Win'].filter(Boolean);
  return [...mods, name].join(' + ');
}
const sameBinding = (a, b) => !!a && !!b && (a.mouse != null || b.mouse != null
  ? a.mouse === b.mouse
  : a.code === b.code && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift && !!a.meta === !!b.meta);

/** Does the event match the binding? Hold keys (PTT) ignore extra modifiers. */
function matches(b, e, hold) {
  if (!b || b.mouse != null || e.code !== b.code) return false;
  if (hold && !b.ctrl && !b.alt && !b.shift && !b.meta) return true;
  return !!b.ctrl === e.ctrlKey && !!b.alt === e.altKey && !!b.shift === e.shiftKey && !!b.meta === e.metaKey;
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
const hotkeysActive = () => !S.recordingKey && !$('#app').hidden && $('#modal-backdrop').hidden && $('#help-layer').hidden;

function pttPress(down) {
  if (S.pttDown === down) return;
  S.pttDown = down;
  $('#ptt-button').classList.toggle('down', down);
  if (S.mini) S.mini.document.querySelector('.mini .ptt')?.classList.toggle('down', down);
}

function runAction(id) {
  if (id === 'mic') toggleInputMute();
  else if (id === 'speaker') toggleOutputMute();
  else if (id === 'away') toggleAway();
  else if (id === 'help') openHelp('tasten');
}

function onHotkeyDown(e) {
  // F1 opens the help also on the start page and over dialogs
  if (!S.recordingKey && $('#help-layer').hidden && matches(settings.keys.help, e, false) && !isTyping(e)) {
    e.preventDefault(); openHelp('tasten'); return;
  }
  if (!hotkeysActive()) return;
  if (settings.mode === 'ptt' && matches(settings.keys.ptt, e, true) && !isTyping(e)) {
    e.preventDefault();
    pttPress(true);
    return;
  }
  if (isTyping(e) || e.repeat) return;
  for (const [id, , hold] of KEY_ACTIONS) {
    if (hold || id === 'help') continue;
    if (matches(settings.keys[id], e, false)) { e.preventDefault(); runAction(id); return; }
  }
}
function onHotkeyUp(e) {
  const b = settings.keys.ptt;
  // Release also when the modifier of a combination is let go first.
  if (S.pttDown && b && b.mouse == null && (e.code === b.code || (b.ctrl && /^Control/.test(e.code)) || (b.alt && /^Alt/.test(e.code)) || (b.shift && /^Shift/.test(e.code)) || (b.meta && /^Meta/.test(e.code)))) pttPress(false);
}
// Mouse buttons (middle, side buttons). The side buttons would otherwise
// navigate back/forward – prevented while they are bound.
const boundMouse = (n) => Object.values(settings.keys).some((b) => b && b.mouse === n);
function onHotMouseDown(e) {
  if (S.recordingKey || e.button < 1 || !boundMouse(e.button)) return;
  if (!hotkeysActive()) return;
  e.preventDefault();
  if (settings.mode === 'ptt' && settings.keys.ptt && settings.keys.ptt.mouse === e.button) { pttPress(true); return; }
  for (const [id, , hold] of KEY_ACTIONS) if (!hold && settings.keys[id] && settings.keys[id].mouse === e.button) { runAction(id); return; }
}
function onHotMouseUp(e) {
  if (e.button >= 1 && boundMouse(e.button)) e.preventDefault(); // no back/forward navigation
  const b = settings.keys.ptt;
  if (S.pttDown && b && b.mouse === e.button) pttPress(false);
}
/** Hotkeys work in the main tab and in the mini window. */
function bindHotkeys(win) {
  win.addEventListener('keydown', onHotkeyDown);
  win.addEventListener('keyup', onHotkeyUp);
  win.addEventListener('mousedown', onHotMouseDown);
  win.addEventListener('mouseup', onHotMouseUp);
  win.addEventListener('auxclick', (e) => { if (e.button >= 1 && boundMouse(e.button)) e.preventDefault(); });
}
bindHotkeys(window);
// Desktop app (funkraum): keys and mouse buttons pressed while the window is in
// the background arrive here, so push-to-talk and the other shortcuts work globally.
window.tsGlobalInput = (ev) => {
  if (document.hasFocus()) return; // the page gets its own events then
  const e = {
    code: ev.code, button: ev.button, repeat: false, target: null, preventDefault() {},
    ctrlKey: !!ev.ctrl, altKey: !!ev.alt, shiftKey: !!ev.shift, metaKey: !!ev.meta,
  };
  if (ev.type === 'keydown') {
    if (matches(settings.keys.help, e, false)) return; // no help window from the background
    onHotkeyDown(e);
  } else if (ev.type === 'keyup') onHotkeyUp(e);
  else if (ev.type === 'mousedown') onHotMouseDown(e);
  else if (ev.type === 'mouseup') onHotMouseUp(e);
};
window.addEventListener('blur', () => { if (!S.mini || !S.mini.document.hasFocus()) pttPress(false); });

// ---------------------------------------------------------------- mini window
// A small, compact window: your channel, who is talking, mute buttons.
// Chrome/Edge: Document Picture-in-Picture (always on top of other programs).
// Other browsers: a small normal popup window. The audio keeps running in the tab.
async function openMini() {
  if (S.mini && !S.mini.closed) { S.mini.focus(); return; }
  let w = null;
  try {
    if ('documentPictureInPicture' in window) {
      w = await documentPictureInPicture.requestWindow({ width: 300, height: 380 });
    } else {
      w = window.open('', 'tsweb-mini', 'popup,width=300,height=380');
    }
  } catch (e) { console.warn('Mini-Fenster', e); }
  if (!w) { toast('Das kleine Fenster wurde vom Browser blockiert. Bitte Pop-ups für diese Seite erlauben.', 'error'); return; }
  const d = w.document;
  d.title = (S.server && S.server.name) || 'Funkraum';
  if (!d.head.querySelector('link[rel=stylesheet]')) {
    const css = d.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('style.css', location.href).href;
    d.head.append(css);
    const meta = d.createElement('meta'); meta.name = 'viewport'; meta.content = 'width=device-width, initial-scale=1';
    d.head.append(meta);
  }
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme) d.documentElement.setAttribute('data-theme', theme); else d.documentElement.removeAttribute('data-theme');
  d.body.className = 'mini-body';
  d.body.textContent = '';
  S.mini = w;
  bindHotkeys(w);
  w.addEventListener('blur', () => { if (!document.hasFocus()) pttPress(false); });
  w.addEventListener('pagehide', () => { if (S.mini === w) { S.mini = null; updateMiniButton(); } });
  renderMini();
  updateMiniButton();
}

function closeMini() {
  if (S.mini) { const w = S.mini; S.mini = null; try { w.close(); } catch { /* ignore */ } }
  updateMiniButton();
  window.focus();
}

function updateMiniButton() {
  const b = $('#btn-mini');
  if (b) { b.classList.toggle('on', !!S.mini); b.title = S.mini ? 'Kleines Fenster schließen' : 'Kleines Fenster (immer im Vordergrund)'; }
}

/** Redraw the mini window (called whenever the tree, talking state or toolbar changes). */
function renderMini() {
  const w = S.mini;
  if (!w || w.closed) { S.mini = null; return; }
  const d = w.document;
  const me = S.clients.get(S.ownId);
  const ch = me && S.channels.get(me.channel);
  const btn = (icon, title, active, onclick) => {
    const b = el('button', { class: 'tool' + (active ? ' active' : ''), title, html: icon });
    b.addEventListener('click', onclick);
    return b;
  };
  const head = el('header', { class: 'mini-head' },
    el('span', { class: 'status-dot ' + (S.status === 'connected' ? 'connected' : S.status === 'disconnected' ? '' : 'connecting') }),
    el('div', { class: 'mini-title' },
      el('strong', {}, ch ? ch.name : (S.status === 'connected' ? '…' : 'Nicht verbunden')),
      el('span', { class: 'muted small' }, S.server ? S.server.name : '')),
    btn(S.inputMuted ? ICON.micOff : ICON.mic, S.inputMuted ? 'Mikrofon an' : 'Mikrofon stummschalten', S.inputMuted, toggleInputMute),
    btn(S.outputMuted ? ICON.speakerOff : ICON.speaker, S.outputMuted ? 'Lautsprecher an' : 'Lautsprecher stummschalten', S.outputMuted, toggleOutputMute),
    btn(ICON.expand, 'Zurück zum großen Fenster', false, closeMini));
  const list = el('div', { class: 'mini-list' });
  const people = ch ? clientsIn(ch.id) : [];
  for (const c of people) {
    const row = el('div', { class: 'mini-row' + (c.id === S.ownId ? ' me' : ''), 'data-client': c.id },
      clientAvatar(c), el('span', { class: 'name' }, c.name),
      c.away != null ? el('span', { class: 'muted small' }, 'abwesend') : null);
    list.append(row);
  }
  if (!people.length) list.append(el('p', { class: 'muted small mini-empty' }, S.status === 'connected' ? 'Niemand im Kanal' : 'Die Verbindung ist getrennt.'));
  const foot = el('footer', { class: 'mini-foot' });
  if (S.miniLast) foot.append(el('div', { class: 'mini-msg', title: S.miniLast }, S.miniLast));
  foot.append(el('div', { class: 'muted small' }, $('#tx-state').textContent));
  if (settings.mode === 'ptt' && !S.micError) {
    const ptt = el('button', { class: 'ptt' + (S.pttDown ? ' down' : '') }, 'Gedrückt halten zum Sprechen');
    ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); pttPress(true); try { ptt.setPointerCapture(e.pointerId); } catch { /* ignore */ } });
    ptt.addEventListener('pointerup', () => pttPress(false));
    ptt.addEventListener('pointercancel', () => pttPress(false));
    foot.append(ptt);
  }
  d.body.textContent = '';
  d.body.append(el('div', { class: 'mini' }, head, list, foot));
  updateMiniTalking();
}

function updateMiniTalking() {
  if (!S.mini || S.mini.closed) return;
  S.mini.document.querySelectorAll('.mini-row').forEach((n) => {
    const id = Number(n.dataset.client);
    const talking = S.talking.has(id) || (id === S.ownId && S.transmitting);
    n.querySelector('.talk-dot').classList.toggle('talking', talking);
    n.classList.toggle('talking', talking);
  });
}

/**
 * Wait for the next key (combination) or mouse button. Resolves with a binding,
 * or null if cancelled with Esc. A modifier alone (e.g. Strg) can be bound by
 * pressing and releasing it.
 */
function recordBinding(allowMouse) {
  return new Promise((resolve) => {
    S.recordingKey = true;
    let pendingMod = null;
    const finish = (b) => {
      S.recordingKey = false;
      window.removeEventListener('keydown', kd, true);
      window.removeEventListener('keyup', ku, true);
      window.removeEventListener('mousedown', md, true);
      window.removeEventListener('contextmenu', cm, true);
      resolve(b);
    };
    const kd = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) return finish(null);
      if (MOD_CODES.has(e.code)) { pendingMod = e.code; return; }
      finish({ code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
    };
    const ku = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (pendingMod && e.code === pendingMod) finish({ code: pendingMod });
    };
    const md = (e) => {
      if (!allowMouse || e.button < 1) return; // left/right click: keep the UI usable
      e.preventDefault(); e.stopPropagation();
      finish({ mouse: e.button });
    };
    const cm = (e) => { if (S.recordingKey) e.preventDefault(); };
    window.addEventListener('keydown', kd, true);
    window.addEventListener('keyup', ku, true);
    window.addEventListener('mousedown', md, true);
    window.addEventListener('contextmenu', cm, true);
  });
}

/** Ask for a new key for an action; removes it from other actions if taken. */
async function changeBinding(id, btn) {
  const old = btn.textContent;
  btn.textContent = 'Taste drücken… (Esc = abbrechen)';
  btn.classList.add('recording');
  const b = await recordBinding(true);
  btn.classList.remove('recording');
  btn.textContent = old;
  if (!b) return false;
  for (const [other, label] of KEY_ACTIONS) {
    if (other !== id && sameBinding(settings.keys[other], b)) {
      settings.keys[other] = null;
      toast(`${keyLabel(b)} war für „${label}“ belegt – dort entfernt`);
    }
  }
  settings.keys[id] = b;
  saveSettings();
  updateTxState();
  return true;
}

// ---------------------------------------------------------------- settings dialog
async function openSettings() {
  const body = $('#tpl-settings').content.cloneNode(true).firstElementChild;
  openModal('Einstellungen', body, [el('button', { class: 'primary', onclick: () => closeModal() }, 'Fertig')]);
  const q = (s) => body.querySelector(s);

  // Opened from the start page: switch the microphone on for the level meter
  // (to set the voice activation threshold) and release it again afterwards.
  if (S.status !== 'connected' && !S.ws) {
    q('#s-preview-note').hidden = false;
    S.onModalClose = () => { if (!S.ws) stopMic(); };
    try { await setupAudio(); } catch (e) { console.warn('audio setup', e); }
  }

  // devices
  const sinkMode = sinkSupport();
  const canPick = sinkMode === 'element' && navigator.mediaDevices && typeof navigator.mediaDevices.selectAudioOutput === 'function';
  const fillDevices = async () => {
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { /* ignore */ }
    const fill = (sel, kind, cur, extra) => {
      const { defaultName, list } = deviceList(devs, kind);
      // a device chosen earlier (Firefox lists outputs only after picking one)
      if (extra && cur && !list.some((d) => d.id === cur)) list.push({ id: cur, label: extra });
      sel.replaceChildren(el('option', { value: '' }, defaultName ? `Standard – ${defaultName}` : 'Standard (vom System)'),
        ...list.map((d) => el('option', { value: d.id }, d.label)));
      sel.value = list.some((d) => d.id === cur) ? cur : '';
      return list.length;
    };
    fill(q('#s-input-device'), 'audioinput', settings.inputDevice);
    const outputs = fill(q('#s-output-device'), 'audiooutput', settings.outputDevice, settings.outputLabel || 'Gewähltes Gerät');
    const hint = q('#s-output-hint');
    q('#s-output-device').disabled = sinkMode === 'none';
    q('#s-output-pick').hidden = !canPick;
    hint.hidden = false;
    if (sinkMode === 'none') {
      hint.textContent = 'Dieser Browser lässt die Seite den Lautsprecher nicht wählen. Das Gerät entscheidet selbst – z. B. Kopfhörer oder Bluetooth anschließen, auf dem iPhone über das Kontrollzentrum.';
    } else if (canPick) {
      hint.textContent = 'Firefox zeigt die Lautsprecher erst, wenn du einmal „Gerät wählen…“ benutzt hast.';
    } else if (!outputs) {
      hint.textContent = 'Der Browser meldet keine weiteren Ausgabegeräte. Auf Handys schaltet das System selbst auf Kopfhörer oder Bluetooth um.';
    } else {
      hint.hidden = true;
    }
  };
  await fillDevices();
  // Bluetooth headset switched on, USB headset plugged in …
  navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener('devicechange', fillDevices);
  const prevClose = S.onModalClose;
  S.onModalClose = () => {
    if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener) navigator.mediaDevices.removeEventListener('devicechange', fillDevices);
    if (prevClose) prevClose();
  };
  q('#s-input-device').addEventListener('change', (e) => { settings.inputDevice = e.target.value; saveSettings(); startMic(); });
  q('#s-output-device').addEventListener('change', (e) => {
    settings.outputDevice = e.target.value;
    settings.outputLabel = e.target.value ? e.target.selectedOptions[0].textContent : '';
    saveSettings();
    applyOutputDevice();
  });
  q('#s-output-pick').addEventListener('click', async () => {
    try {
      const d = await navigator.mediaDevices.selectAudioOutput();
      settings.outputDevice = d.deviceId;
      settings.outputLabel = d.label || 'Gewähltes Gerät';
      saveSettings();
      await applyOutputDevice();
      await fillDevices();
    } catch (e) { if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Gerät konnte nicht gewählt werden', 'error'); }
  });

  const mode = q('#s-mode');
  mode.value = settings.mode;
  const syncMode = () => {
    q('#s-ptt-row').hidden = settings.mode !== 'ptt';
    q('#s-vad-row').hidden = settings.mode !== 'vad' && settings.mode !== 'auto';
    q('#s-vad-manual').hidden = settings.mode !== 'vad';
    q('#s-vad-auto').hidden = settings.mode !== 'auto';
  };
  syncMode();
  mode.addEventListener('change', () => { settings.mode = mode.value; saveSettings(); syncMode(); stopTransmit(); updateTxState(); });

  const renderKeys = () => {
    q('#s-ptt-key').textContent = keyLabel(settings.keys.ptt);
    const box = q('#s-keys');
    box.textContent = '';
    for (const [id, label] of KEY_ACTIONS) {
      const change = el('button', { type: 'button', class: 'small' }, 'Ändern');
      change.addEventListener('click', async () => { if (await changeBinding(id, change)) renderKeys(); });
      const clear = settings.keys[id] ? el('button', { type: 'button', class: 'small', title: 'Keine Taste', onclick: () => { settings.keys[id] = null; saveSettings(); updateTxState(); renderKeys(); } }, '✕') : null;
      box.append(el('div', { class: 'key-row' },
        el('span', {}, label),
        el('kbd', { class: settings.keys[id] ? '' : 'none' }, keyLabel(settings.keys[id])),
        el('div', { class: 'key-btns' }, change, clear)));
    }
  };
  renderKeys();
  q('#s-ptt-record').addEventListener('click', async (ev) => { if (await changeBinding('ptt', ev.target)) renderKeys(); });
  q('#s-keys-reset').addEventListener('click', () => { settings.keys = DEFAULT_KEYS(); saveSettings(); updateTxState(); renderKeys(); toast('Standard-Tastenbelegung wiederhergestellt'); });

  const range = (id, key, fmt, onChange) => {
    const r = q(id), v = q(id + '-val');
    r.value = settings[key];
    v.textContent = fmt(settings[key]);
    r.addEventListener('input', () => { settings[key] = Number(r.value); v.textContent = fmt(settings[key]); saveSettings(); onChange && onChange(); });
  };
  range('#s-vad', 'vadDb', (x) => x + ' dB');
  range('#s-gain', 'gain', (x) => x + ' %', () => S.captureNode && S.captureNode.port.postMessage({ gain: settings.gain / 100 }));
  range('#s-volume', 'volume', (x) => x + ' %', () => S.outGain && (S.outGain.gain.value = settings.volume / 100));

  const check = (id, key, onChange) => {
    const c = q(id);
    c.checked = settings[key];
    c.addEventListener('change', () => { settings[key] = c.checked; saveSettings(); onChange && onChange(); });
  };
  check('#s-echo', 'echo', startMic);
  check('#s-noise', 'noise', startMic);
  check('#s-autolevel', 'autoLevel', () => S.captureNode && S.captureNode.port.postMessage({ autoLevel: settings.autoLevel }));
  updateMicCheck();
  const testBtn = q('#s-mic-test');
  testBtn.addEventListener('click', () => micTest(testBtn));
  check('#s-denoise', 'denoise', () => { S.captureNode && S.captureNode.port.postMessage({ denoise: settings.denoise }); updateMicCheck(); });
  check('#s-agc', 'agc', startMic);
  const sm = q('#s-sound-mode');
  if (!('speechSynthesis' in window)) sm.querySelector('option[value="voice"]').disabled = true;
  sm.value = settings.soundMode;
  sm.addEventListener('change', () => { settings.soundMode = sm.value; saveSettings(); sound('connected', { force: sm.value !== 'off' }); });
  range('#s-sound-volume', 'soundVolume', (x) => x + ' %');
  q('#s-sound-volume').addEventListener('change', () => sound('message', { force: true }));
  q('#s-sounds-edit').addEventListener('click', () => soundDialog());
  check('#s-joinleave', 'joinLeave');
  const histRow = q('#s-history-row');
  if (histRow) {
    histRow.hidden = !(S.config && S.config.history);
    check('#s-history', 'history', () => { if (settings.history && S.status === 'connected') historyStart(); });
    q('#s-history-delete').addEventListener('click', () => {
      if (confirm('Den gespeicherten Chatverlauf dieser Identität auf diesem Server löschen?')) historyDelete();
    });
  }
  check('#s-notify', 'notify', async () => {
    if (settings.notify && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { settings.notify = false; saveSettings(); q('#s-notify').checked = false; toast('Benachrichtigungen wurden nicht erlaubt', 'error'); }
    }
  });
  const theme = q('#s-theme');
  theme.value = settings.theme;
  theme.addEventListener('change', () => { settings.theme = theme.value; saveSettings(); applyTheme(); });
  check('#s-show-query', 'showQuery', () => { if (S.status === 'connected') renderTree(); });
  const shareRow = q('#s-share-row');
  if (shareRow) {
    shareRow.hidden = !(S.config && S.config.desktop);
    const inp = q('#s-share-server');
    inp.value = settings.shareServer || '';
    inp.placeholder = (S.config && S.config.share_server) || 'ts.example.com';
    const info = q('#s-share-info');
    const show = () => { const s = FunkShare.server(inp.value || (S.config && S.config.share_server) || ''); info.textContent = s ? `Bildschirme laufen über ${s.host}.` : 'Noch keine Brücke eingetragen – Bildschirm teilen und ansehen geht erst danach.'; };
    show();
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (v && !FunkShare.server(v)) { toast('Das ist keine gültige Adresse.', 'error'); return; }
      settings.shareServer = v;
      saveSettings();
      show();
      if (S.status === 'connected') { shareStop(); shareSync(); }
    });
  }

  // identity
  const idNow = (S.status === 'connected' && S.identity) || activeIdentity();
  q('#s-id-name').textContent = idNow ? idNow.name : 'keine';
  q('#s-uid').textContent = idNow ? idNow.uid : '–';
  q('#s-id-manage').addEventListener('click', () => identityManager());
}

// ---------------------------------------------------------------- screen sharing
// The picture does not go through the TeamSpeak server (it cannot carry video)
// but through a Funkraum-Web bridge (share.js, /share/ws). Everybody in the same
// TeamSpeak channel meets in one room: unique id of the server + channel id.
const SH = { session: null, streams: [], sending: null, cids: '' };

/** The bridge for screen sharing: this bridge, or in the desktop app the one from the settings. */
function shareServer() {
  if (!window.FunkShare || !S.config) return null;
  if (S.config.desktop) return FunkShare.server(settings.shareServer || S.config.share_server || '');
  return S.config.share ? FunkShare.here() : null;
}

function shareRoom() {
  const me = S.clients.get(S.ownId);
  if (!S.server || !S.server.uid || !me) return null;
  return `${S.server.uid}/${me.channel}`;
}

/** Join, follow or leave the room of the own channel (after every state update). */
function shareSync() {
  const srv = S.status === 'connected' ? shareServer() : null;
  const room = srv && shareRoom();
  const me = S.clients.get(S.ownId);
  if (!room || !me) {
    if (SH.session) {
      SH.session.close();
      SH.session = null;
      SH.streams = [];
      SH.sending = null;
      renderShare();
      renderScreens();
    }
    updateShareButton();
    return;
  }
  const info = { room, url: srv.ws, name: me.name, cid: me.id, uid: me.uid || null };
  if (!SH.session) {
    SH.session = new FunkShare.Session(Object.assign({
      audioOut: () => (S.ctx && (S.outGain || S.outBus) ? { ctx: S.ctx, node: S.outGain || S.outBus } : null),
      audioMuted: () => S.outputMuted,
    }, info));
    SH.session.on('streams', (list) => {
      SH.streams = list;
      renderShare();
      const cids = list.map((s) => s.cid).sort().join(',');
      if (cids !== SH.cids) { SH.cids = cids; renderTree(); }
    });
    SH.session.on('sending', (s) => {
      const changed = !SH.sending !== !s;
      SH.sending = s;
      renderShare();
      updateShareButton();
      if (changed) renderTree();
    });
    SH.session.on('watching', () => { renderScreens(); renderTree(); });
    SH.session.on('error', (text) => toast(text, 'error'));
    SH.session.on('status', (st) => { if (st === 'open' || st === 'reconnecting') renderShare(); });
    SH.session.connect();
  } else if (SH.session.update(info) && SH.sending) {
    toast('Deine Bildschirmübertragung läuft jetzt in deinem neuen Kanal weiter.');
  }
  updateShareButton();
}

function shareStop() {
  if (SH.session) SH.session.close();
  SH.session = null;
  SH.streams = [];
  SH.sending = null;
  SH.cids = '';
  renderShare();
  renderScreens();
  updateShareButton();
}

/** The stream a client of the tree is sharing (same TeamSpeak server, so the client id matches). */
function shareOf(clientId) { return SH.streams.find((s) => s.cid === clientId) || null; }

function updateShareButton() {
  const b = $('#btn-share');
  if (!b) return;
  const on = !!SH.sending;
  b.innerHTML = on ? FunkShare.ICON.screenOff : FunkShare.ICON.screen;
  b.classList.toggle('on', on);
  b.title = on ? 'Bildschirmübertragung beenden' : 'Bildschirm teilen';
  b.hidden = !window.FunkShare || !(S.config && (S.config.share || S.config.desktop))
    || (!FunkShare.support().send && !S.config.desktop); // phones: watching only
}

/** Bar above the chat: own share and the screens of the others in the channel. */
function renderShare() {
  const bar = $('#screen-bar');
  if (!bar) return;
  bar.textContent = '';
  const ses = SH.session;
  if (SH.sending && ses) {
    const s = SH.sending;
    const parts = [s.viewers === 1 ? '1 Zuschauer' : `${s.viewers} Zuschauer`];
    if (ses.state === 'reconnecting') parts.push('verbinde neu…');
    const chip = el('div', { class: 'screen-chip own' },
      el('span', { class: 'ico', html: FunkShare.ICON.screen }),
      el('span', {}, el('strong', {}, 'Du teilst deinen Bildschirm'), ' · ', parts.join(' · ')));
    const audioBtn = el('button', { type: 'button', class: 'small' + (s.audio ? ' on' : ''), title: s.hasAudio ? '' : 'Beim Start wurde kein Ton freigegeben' }, s.audio ? 'Ton an' : 'Ton aus');
    audioBtn.addEventListener('click', () => {
      if (!ses.setAudio(!s.audio)) toast('Es wurde kein Ton freigegeben. Beende die Übertragung und hake beim nächsten Mal im Auswahlfenster „Ton teilen“ an (nur Chrome, Edge, Opera und die Desktop-App unter Windows).', 'error');
    });
    const linkBtn = el('button', { type: 'button', class: 'small', title: 'Link für Leute ohne Funkraum, z. B. mit dem TeamSpeak-Programm: Sie schauen im Browser zu' }, 'Link kopieren');
    linkBtn.addEventListener('click', () => shareCopyLink());
    const stopBtn = el('button', { type: 'button', class: 'small danger' }, 'Beenden');
    stopBtn.addEventListener('click', () => ses.stopSharing());
    chip.append(audioBtn, linkBtn, stopBtn);
    bar.append(chip);
  }
  for (const st of SH.streams) {
    if (ses && ses.viewers.has(st.id)) continue;
    const btn = el('button', { type: 'button', class: 'small primary' }, 'Ansehen');
    btn.addEventListener('click', () => shareWatch(st.id));
    bar.append(el('div', { class: 'screen-chip' },
      el('span', { class: 'ico', html: FunkShare.ICON.screen }),
      el('span', {}, el('strong', {}, st.name), ' teilt den Bildschirm', st.audio ? ' (mit Ton)' : ''),
      btn));
  }
  bar.hidden = !bar.childNodes.length;
}

function renderScreens() {
  const box = $('#screens');
  if (!box) return;
  const tiles = SH.session ? [...SH.session.viewers.values()].map((v) => v.el) : [];
  box.replaceChildren(...tiles);
  box.hidden = !tiles.length;
  box.dataset.count = String(tiles.length);
  renderShare();
}

function shareWatch(id) {
  if (!SH.session) return;
  const srv = shareServer();
  if (!FunkShare.support().view) {
    const room = shareRoom();
    if (srv && room) {
      confirmDialog('Diese Ansicht kann das Bild nicht anzeigen (WebCodecs fehlt). Du kannst im Browser zuschauen.', { title: 'Bildschirm ansehen', okLabel: 'Im Browser öffnen', icon: 'question' })
        .then((ok) => ok && FunkShare.openExternal(FunkShare.link(srv, room)));
    } else toast('Dein Browser kann das Bild nicht anzeigen. Probiere Chrome, Edge, Firefox oder Safari.', 'error');
    return;
  }
  SH.session.watch(id);
  if (window.matchMedia && matchMedia('(max-width: 760px)').matches) showPane('chat');
}

function shareCopyLink() {
  const srv = shareServer();
  const room = shareRoom();
  if (!srv || !room) return;
  const url = FunkShare.link(srv, room);
  const done = () => toast('Link kopiert. Wer ihn öffnet, sieht die Bildschirme in deinem Kanal – gib ihn nur an Leute weiter, die zuschauen dürfen.');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => promptDialog('Link zum Zuschauen', url, { label: 'Link kopieren:' }));
  else promptDialog('Link zum Zuschauen', url, { label: 'Link kopieren:' });
}

async function shareDialog() {
  if (SH.sending && SH.session) { SH.session.stopSharing(); return; }
  if (!window.FunkShare) return;
  const srv = shareServer();
  if (!srv) {
    if (S.config && S.config.desktop) {
      toast('Trage zuerst unter Einstellungen → „Bildschirm teilen“ die Adresse einer Funkraum-Web-Brücke ein.', 'error');
      openSettings();
    } else toast('Die Bildschirmübertragung ist auf dieser Brücke ausgeschaltet.', 'error');
    return;
  }
  if (!SH.session || SH.session.state !== 'open') {
    toast('Verbindung zur Bildschirmübertragung wird noch aufgebaut – bitte gleich noch einmal versuchen.', 'error');
    return;
  }
  const room = shareRoom();
  const me = S.clients.get(S.ownId);
  if (!FunkShare.support().send) {
    if (S.config.desktop && room) {
      const ok = await confirmDialog('Diese Ansicht kann den Bildschirm nicht aufnehmen. Funkraum öffnet dafür deinen Browser – dort wählst du den Bildschirm, alle in deinem Kanal sehen ihn wie gewohnt.', { title: 'Bildschirm teilen', okLabel: 'Im Browser teilen', icon: 'question' });
      if (ok) FunkShare.openExternal(FunkShare.link(srv, room, { send: 1, n: me ? me.name : '', c: me ? me.id : '', u: (me && me.uid) || '' }));
    } else {
      toast('Dein Browser kann den Bildschirm nicht teilen (auf Handys und Tablets geht das nicht). Zuschauen geht trotzdem.', 'error');
    }
    return;
  }
  const form = FunkShare.optionsForm(store.get('sharePrefs', {}));
  const go = await new Promise((resolve) => {
    modalResolve = resolve;
    const ok = el('button', { class: 'primary', onclick: () => { modalResolve = null; closeModal(); resolve(true); } }, 'Bildschirm wählen…');
    openModal('Bildschirm teilen', el('div', {},
      el('p', { class: 'muted small' }, 'Alle in deinem Kanal können zuschauen – auch wer über eine andere Funkraum-Brücke oder die Desktop-App verbunden ist. Das Bild läuft über die Brücke, nicht über den TeamSpeak-Server. Danach fragt der Browser, welchen Bildschirm, welches Fenster oder welchen Tab du teilen möchtest.'),
      form.node), [el('button', { onclick: () => closeModal(false) }, 'Abbrechen'), ok]);
  });
  if (!go || !SH.session) return;
  const opts = form.values();
  store.set('sharePrefs', opts);
  try {
    const info = await SH.session.startSharing(opts);
    if (opts.audio && !info.hasAudio && FunkShare.support().audio) toast('Ohne Ton: Im Auswahlfenster war „Ton teilen“ nicht angehakt.');
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (/abgebrochen/.test(msg)) return;
    if (S.config.desktop && room) {
      const ok = await confirmDialog(`${msg} Du kannst den Bildschirm stattdessen im Browser teilen.`, { title: 'Bildschirm teilen', okLabel: 'Im Browser teilen', icon: 'warn' });
      if (ok) FunkShare.openExternal(FunkShare.link(srv, room, { send: 1, n: me ? me.name : '', c: me ? me.id : '', u: (me && me.uid) || '' }));
    } else toast(msg, 'error');
  }
}

/** Record 5 seconds of what the others would hear and play it back. */
async function micTest(btn) {
  if (!S.captureNode) { toast(S.micError || 'Kein Mikrofon verfügbar', 'error'); return; }
  const ctx = fxCtx();
  btn.disabled = true;
  S.testRec = [];
  for (let i = 5; i > 0; i--) { btn.textContent = `Sprich jetzt… ${i}`; await new Promise((r) => setTimeout(r, 1000)); }
  const frames = S.testRec; S.testRec = null;
  const len = frames.reduce((n, f) => n + f.length, 0);
  if (!len) { btn.disabled = false; btn.textContent = 'Mikrofon testen'; return; }
  const buf = ctx.createBuffer(1, len, 48000);
  const ch = buf.getChannelData(0);
  let off = 0;
  for (const f of frames) { ch.set(f, off); off += f.length; }
  btn.textContent = 'Wiedergabe – so hören dich die anderen';
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(sinkOf(ctx));
  src.onended = () => { btn.disabled = false; btn.textContent = 'Mikrofon testen'; };
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  src.start();
}

/** Per event: on/off, test, own sound file. */
function soundDialog() {
  const body = el('div', { class: 'sound-list' });
  const render = () => {
    body.textContent = '';
    body.append(el('p', { class: 'small muted' }, 'Für jedes Ereignis kannst du den Hinweis ausschalten oder eine eigene Audiodatei wählen (z. B. .wav oder .mp3, höchstens 2 MB). Eigene Dateien werden nur in diesem Browser gespeichert und haben Vorrang vor Ansage und Ton.'));
    for (const [id, label] of SOUND_EVENTS) {
      const custom = S.customSounds && S.customSounds.get(id);
      const on = el('input', { type: 'checkbox', checked: !settings.soundOff.includes(id) });
      on.addEventListener('change', () => {
        settings.soundOff = settings.soundOff.filter((x) => x !== id);
        if (!on.checked) settings.soundOff.push(id);
        saveSettings();
      });
      const file = el('input', { type: 'file', accept: 'audio/*', hidden: true });
      file.addEventListener('change', async () => {
        const f = file.files && file.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) return toast('Die Datei ist größer als 2 MB', 'error');
        try {
          await fxCtx().decodeAudioData(await f.arrayBuffer()); // check it is audio
          const entry = { name: f.name, blob: f };
          await soundStore('readwrite', (st) => st.put(entry, id));
          S.customSounds.set(id, entry); S.decoded.delete(id);
          sound(id, { force: true });
          render();
        } catch { toast('Diese Datei kann der Browser nicht abspielen', 'error'); }
      });
      const reset = custom ? el('button', { class: 'small', title: 'Eigene Datei entfernen', onclick: async () => {
        await soundStore('readwrite', (st) => st.delete(id)).catch(() => {});
        S.customSounds.delete(id); S.decoded.delete(id);
        render();
      } }, '✕') : null;
      body.append(el('div', { class: 'sound-row' },
        el('label', { class: 'check' }, on, label),
        el('span', { class: 'sound-src muted small', title: custom ? custom.name : '' }, custom ? custom.name : (settings.soundMode === 'voice' ? 'Ansage' : 'Ton')),
        el('div', { class: 'sound-btns' },
          el('button', { class: 'small', title: 'Anhören', onclick: () => sound(id, { force: true }) }, '▶'),
          el('button', { class: 'small', onclick: () => file.click() }, 'Datei…'),
          reset, file)));
    }
  };
  render();
  openModal('Hinweise anpassen', body, [
    el('button', { onclick: () => openSettings() }, 'Zurück'),
    el('button', { class: 'primary', onclick: () => closeModal() }, 'Fertig'),
  ]);
}

// ---------------------------------------------------------------- static UI wiring
function showPane(name) {
  document.querySelectorAll('.mobile-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  $('#pane-tree').classList.toggle('active', name === 'tree');
  $('#pane-chat').classList.toggle('active', name === 'chat');
  updateMobileBadge();
}

function setupStaticUI() {
  $('#btn-info').innerHTML = ICON.info;
  $('#btn-manage').innerHTML = ICON.shield;
  $('#btn-manage').addEventListener('click', () => openManage('server'));
  $('#btn-settings').innerHTML = ICON.settings;
  $('#btn-help').innerHTML = ICON.help;
  $('#btn-mini').innerHTML = ICON.mini;
  $('#btn-share').addEventListener('click', shareDialog);
  updateShareButton();
  $('#btn-mini').addEventListener('click', () => (S.mini ? closeMini() : openMini()));
  $('#login-settings').innerHTML = ICON.settings;
  $('#login-settings').addEventListener('click', openSettings);
  $('#btn-away').innerHTML = ICON.away;
  $('#btn-disconnect').innerHTML = ICON.power;
  $('#btn-new-channel').innerHTML = ICON.plus;
  $('#btn-mic').addEventListener('click', toggleInputMute);
  $('#btn-speaker').addEventListener('click', toggleOutputMute);
  $('#btn-away').addEventListener('click', toggleAway);
  $('#btn-info').addEventListener('click', showServerInfo);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-disconnect').addEventListener('click', disconnect);
  $('#btn-new-channel').addEventListener('click', () => createChannelDialog(0));
  $('#modal-close').addEventListener('click', () => closeModal());
  $('#help-close').addEventListener('click', closeHelp);
  $('#help-layer').addEventListener('click', (e) => { if (e.target.id === 'help-layer') closeHelp(); });
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });
  $('#tree-filter').addEventListener('input', renderTree);
  document.querySelectorAll('.mobile-tabs button').forEach((b) => b.addEventListener('click', () => showPane(b.dataset.pane)));

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-text');
    const text = input.value.trim();
    if (!text) return;
    const key = S.activeTab;
    if (key === 'server') send({ t: 'message', target: 'server', text });
    else if (key === 'channel') send({ t: 'message', target: 'channel', text });
    else if (key.startsWith('pm:')) {
      const tab = S.tabs.get(key);
      if (!tab || tab.clientId == null) {
        addMsg(key, { sys: true, text: `${tab ? tab.title.replace(/ \(offline\)$/, '') : 'Der Nutzer'} ist gerade nicht online – die Nachricht wurde nicht gesendet.` });
        return;
      }
      send({ t: 'message', target: 'client', client: tab.clientId, text });
    }
    input.value = '';
  });

  const ptt = $('#ptt-button');
  const down = (e) => { e.preventDefault(); S.pttDown = true; ptt.classList.add('down'); try { ptt.setPointerCapture(e.pointerId); } catch { /* ignore */ } };
  const up = () => { S.pttDown = false; ptt.classList.remove('down'); };
  ptt.addEventListener('pointerdown', down);
  ptt.addEventListener('pointerup', up);
  ptt.addEventListener('pointercancel', up);
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());

  // resume audio if the browser suspended it
  document.addEventListener('click', () => { if (S.ctx && S.ctx.state === 'suspended') S.ctx.resume(); });
  window.addEventListener('beforeunload', () => { if (S.ws) { S.userDisconnect = true; send({ t: 'disconnect', message: 'Browser geschlossen' }); } });
  // keep-alive against idle proxies
  setInterval(() => { if (S.status === 'connected') send({ t: 'ping' }); }, 25000);
  requestAnimationFrame(meterLoop);
}

init();
