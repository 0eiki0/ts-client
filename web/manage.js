'use strict';
/* Funkraum – management dialogs: server settings, full channel editor, server and
 * channel groups, permission editor, bans, privilege keys, complaints and
 * temporary server passwords.
 *
 * Every change is sent as a TeamSpeak command over the user's own connection
 * (`{t:'admin'}`), so the TeamSpeak server checks the permissions exactly like for
 * the official client. Uses the helpers of app.js ($, el, S, send, openModal, …). */

// ---------------------------------------------------------------- requests
const ADM = { seq: 0, waiting: new Map(), perms: null, permsLoading: null, sgroups: null, cgroups: null };

/** Send a management command; resolves with the notifications of the answer. */
function adm(cmd, parts = {}, flags = []) {
  return new Promise((resolve, reject) => {
    if (S.status !== 'connected') { reject(new Error('Nicht verbunden')); return; }
    const id = ++ADM.seq;
    const timer = setTimeout(() => { ADM.waiting.delete(id); reject(new Error('Keine Antwort von der Brücke')); }, 90000);
    ADM.waiting.set(id, { resolve, reject, timer });
    send({ t: 'admin', id, cmd, parts: Array.isArray(parts) ? parts : [parts], flags });
  });
}

function onAdminResult(m) {
  const w = ADM.waiting.get(m.id);
  if (!w) return;
  ADM.waiting.delete(m.id);
  clearTimeout(w.timer);
  if (m.ok) { w.resolve(m.data || []); return; }
  let text = m.error || 'Unbekannter Fehler';
  // "fehlendes Recht: 123" -> permission name
  text = text.replace(/fehlendes Recht: (\d+)/, (all, id) => {
    const p = ADM.perms && ADM.perms.byId.get(Number(id));
    return p ? `fehlendes Recht: ${p.name}` : all;
  });
  const e = new Error(text);
  e.code = m.code;
  w.reject(e);
}

/** Forget everything that belongs to the server (called when leaving it). */
function admReset() {
  for (const w of ADM.waiting.values()) { clearTimeout(w.timer); w.reject(new Error('Verbindung beendet')); }
  ADM.waiting.clear();
  ADM.perms = null; ADM.permsLoading = null; ADM.sgroups = null; ADM.cgroups = null;
}

const items = (data, name) => data.filter((d) => d.name === name).flatMap((d) => d.items);
const fail = (e) => { toast(e.message || String(e), 'error'); };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const fmtDate = (ts) => { const n = Number(ts); return n > 0 ? new Date(n * 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–'; };
const fmtSecs = (s) => { s = Number(s); if (!s) return 'permanent'; return fmtDuration(s); };

/** Run an action with the button disabled; shows errors as toast. */
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { fail(e); return undefined; } finally { if (btn) btn.disabled = false; }
}

// ---------------------------------------------------------------- permissions and groups
const PERM_CATS = [
  ['virtualserver', 'Virtueller Server'], ['channel', 'Kanal'], ['group', 'Gruppen'], ['client', 'Client'],
  ['ft', 'Dateien'], ['serverinstance', 'Instanz'], ['serverquery', 'ServerQuery'], ['permission', 'Rechte'],
];
const permCat = (name) => {
  const rest = name.replace(/^[bi]_/, '');
  const c = PERM_CATS.find(([k]) => rest.startsWith(k + '_'));
  if (c) return c[0];
  if (rest.startsWith('needed_')) return 'permission';
  return 'other';
};
/** Grant ("needed modify power") permissions have the id of the permission + 0x8000. */
const GRANT = 0x8000;

async function permList() {
  if (ADM.perms) return ADM.perms;
  if (!ADM.permsLoading) {
    ADM.permsLoading = adm('permissionlist').then((data) => {
      // The server sends the permissions in id order without `permid`: the first
      // one has id 1 (0 is "unknown"). `group_id_end` entries only group them.
      const byId = new Map();
      let next = 1;
      for (const p of items(data, 'notifypermissionlist')) {
        if (!p.permname) continue;
        const id = p.permid != null && p.permid !== '' ? Number(p.permid) : next;
        next = id + 1;
        if (!Number.isFinite(id) || byId.has(id)) continue;
        byId.set(id, { id, name: p.permname, desc: p.permdesc || '', cat: permCat(p.permname), bool: p.permname.startsWith('b_') });
      }
      const list = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
      ADM.perms = { list, byId, byName: new Map(list.map((p) => [p.name, p])) };
      return ADM.perms;
    }).finally(() => { ADM.permsLoading = null; });
  }
  return ADM.permsLoading;
}

async function serverGroups(force = false) {
  if (!ADM.sgroups || force) {
    const data = await adm('servergrouplist');
    ADM.sgroups = items(data, 'notifyservergrouplist').map((g) => ({ id: num(g.sgid), name: g.name || '', type: num(g.type, 1), sort: num(g.sortid) }))
      .sort((a, b) => a.sort - b.sort || a.id - b.id);
  }
  return ADM.sgroups;
}

async function channelGroups(force = false) {
  if (!ADM.cgroups || force) {
    const data = await adm('channelgrouplist');
    ADM.cgroups = items(data, 'notifychannelgrouplist').map((g) => ({ id: num(g.cgid), name: g.name || '', type: num(g.type, 1), sort: num(g.sortid) }))
      .sort((a, b) => a.sort - b.sort || a.id - b.id);
  }
  return ADM.cgroups;
}

const groupName = (list, id) => (list || []).find((g) => g.id === Number(id))?.name || `#${id}`;

/**
 * Permission editor.
 * opts: { load: () => Promise<[{permid, permvalue, permnegated, permskip}]>,
 *         set: (permid, {value, skip, negated}) => Promise, del: (permid) => Promise,
 *         skip: bool, negate: bool, hint: string }
 */
function permEditor(opts) {
  const root = el('div', { class: 'perm-editor' });
  const search = el('input', { type: 'search', placeholder: 'Recht suchen (Name oder Beschreibung)…' });
  const cat = el('select', {}, el('option', { value: '' }, 'Alle Bereiche'), ...PERM_CATS.map(([k, l]) => el('option', { value: k }, l)), el('option', { value: 'other' }, 'Sonstige'));
  const onlySet = el('input', { type: 'checkbox', checked: true });
  const reload = el('button', { type: 'button', title: 'Neu laden' }, '↻');
  const list = el('div', { class: 'perm-list' }, el('p', { class: 'muted small' }, 'Rechte werden geladen…'));
  const count = el('span', { class: 'muted small' });
  root.append(
    opts.hint ? el('p', { class: 'muted small' }, opts.hint) : null,
    el('div', { class: 'perm-tools' }, search, cat, reload),
    el('div', { class: 'row wrap' }, el('label', { class: 'check' }, onlySet, 'Nur gesetzte Rechte zeigen'), count),
    list);

  let perms = null;
  let values = new Map(); // permid -> {value, skip, negated}

  const load = async () => {
    list.replaceChildren(el('p', { class: 'muted small' }, 'Rechte werden geladen…'));
    try {
      perms = await permList();
      const got = await opts.load();
      values = new Map(got.map((p) => [Number(p.permid), { value: num(p.permvalue), skip: p.permskip === '1', negated: p.permnegated === '1' }]));
      render();
    } catch (e) {
      list.replaceChildren(el('div', { class: 'alert error' }, e.message));
    }
  };

  const inFlight = new Map(); // permid -> value being sent (no duplicate requests)
  const apply = async (id, v, row) => {
    const key = JSON.stringify(v);
    if (inFlight.get(id) === key) return;
    inFlight.set(id, key);
    row && row.classList.add('saving');
    try {
      await opts.set(id, v);
      values.set(id, v);
    } catch (e) { fail(e); }
    inFlight.delete(id);
    row && row.classList.remove('saving');
    render();
  };
  const remove = async (id, row) => {
    row && row.classList.add('saving');
    try { await opts.del(id); values.delete(id); } catch (e) { fail(e); }
    render();
  };

  const valueInput = (p, cur, onSet) => {
    if (p.bool) {
      const cb = el('input', { type: 'checkbox', checked: !!(cur && cur.value), title: 'Wert' });
      cb.addEventListener('change', () => onSet(cb.checked ? 1 : 0));
      return cb;
    }
    const inp = el('input', { type: 'number', class: 'perm-num', placeholder: '–', title: 'Wert' });
    inp.value = cur ? cur.value : '';
    inp.addEventListener('change', () => { if (inp.value.trim() !== '') onSet(Math.trunc(num(inp.value))); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    return inp;
  };

  const render = () => {
    if (!perms) return;
    const q = search.value.trim().toLowerCase();
    const c = cat.value;
    const rows = [];
    const ids = new Set();
    for (const p of perms.list) ids.add(p.id);
    // values for permissions that are not in the list (e.g. newer server)
    const extra = [...values.keys()].filter((id) => !(id & GRANT) && !ids.has(id)).map((id) => ({ id, name: `#${id}`, desc: '', cat: 'other', bool: false }));
    let shown = 0;
    for (const p of perms.list.concat(extra)) {
      const cur = values.get(p.id);
      const grant = values.get(p.id | GRANT);
      if (onlySet.checked && !cur && !grant) continue;
      if (c && p.cat !== c) continue;
      if (q && !p.name.toLowerCase().includes(q) && !p.desc.toLowerCase().includes(q)) continue;
      if (++shown > 400) continue;
      const row = el('div', { class: 'perm-row' + (cur ? ' set' : '') });
      const set = (patch) => {
        const v = Object.assign({ value: cur ? cur.value : 0, skip: cur ? cur.skip : false, negated: cur ? cur.negated : false }, patch);
        const now = values.get(p.id);
        if (now && v.value === now.value && v.skip === now.skip && v.negated === now.negated) return;
        apply(p.id, v, row);
      };
      const ctrls = el('div', { class: 'perm-ctrls' });
      ctrls.append(el('span', { class: 'perm-lbl' }, 'Wert'), valueInput(p, cur, (v) => set({ value: v })));
      if (opts.skip) {
        const sk = el('input', { type: 'checkbox', checked: !!(cur && cur.skip), title: 'Skip: Kanalgruppen- und Kanal-Client-Rechte überschreiben dieses Recht nicht' });
        sk.disabled = !cur;
        sk.addEventListener('change', () => set({ skip: sk.checked }));
        ctrls.append(el('label', { class: 'check perm-flag' }, sk, 'Skip'));
      }
      if (opts.negate) {
        const ng = el('input', { type: 'checkbox', checked: !!(cur && cur.negated), title: 'Negieren: der niedrigste statt des höchsten Werts aller Gruppen gilt' });
        ng.disabled = !cur;
        ng.addEventListener('change', () => set({ negated: ng.checked }));
        ctrls.append(el('label', { class: 'check perm-flag' }, ng, 'Neg.'));
      }
      const gi = el('input', { type: 'number', class: 'perm-num', placeholder: '–', title: 'Grant: welche Rechte-Bearbeitungsstärke nötig ist, um dieses Recht an andere zu vergeben' });
      gi.value = grant ? grant.value : '';
      gi.addEventListener('change', () => {
        if (gi.value.trim() === '') { if (grant) remove(p.id | GRANT, row); return; }
        const v = Math.trunc(num(gi.value));
        if (!grant || grant.value !== v) apply(p.id | GRANT, { value: v, skip: false, negated: false }, row);
      });
      ctrls.append(el('span', { class: 'perm-lbl' }, 'Grant'), gi);
      const delBtn = el('button', { type: 'button', class: 'danger perm-del', title: 'Recht entfernen' }, '✕');
      delBtn.disabled = !cur;
      delBtn.addEventListener('click', () => remove(p.id, row));
      ctrls.append(delBtn);
      row.append(el('div', { class: 'perm-name' }, el('code', {}, p.name), p.desc ? el('div', { class: 'muted small' }, p.desc) : null), ctrls);
      rows.push(row);
    }
    count.textContent = `${shown} ${shown === 1 ? 'Recht' : 'Rechte'}${shown > 400 ? ' (die ersten 400 werden gezeigt – Suche eingrenzen)' : ''}`;
    list.replaceChildren(...(rows.length ? rows : [el('p', { class: 'muted small' }, onlySet.checked && !q ? 'Keine Rechte gesetzt. Haken bei „Nur gesetzte Rechte zeigen“ entfernen, um Rechte hinzuzufügen.' : 'Kein passendes Recht.')]));
  };

  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 150); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  cat.addEventListener('change', render);
  onlySet.addEventListener('change', render);
  reload.addEventListener('click', load);
  load();
  return root;
}

const permRows = (data, name) => items(data, name).filter((p) => p.permid != null && p.permid !== '');

// ---------------------------------------------------------------- small UI helpers
/** Tabs; each pane is built when it is shown the first time. */
function tabView(defs, initial) {
  const bar = el('div', { class: 'mtabs', role: 'tablist' });
  const body = el('div', { class: 'mtab-body' });
  const panes = new Map();
  const show = (key) => {
    for (const b of bar.children) b.classList.toggle('active', b.dataset.key === key);
    for (const [k, p] of panes) p.hidden = k !== key;
    if (!panes.has(key)) {
      const d = defs.find((x) => x.key === key);
      const pane = el('div', { class: 'mtab-pane' });
      panes.set(key, pane);
      body.append(pane);
      try { d.render(pane); } catch (e) { pane.append(el('div', { class: 'alert error' }, e.message)); }
    }
  };
  for (const d of defs) bar.append(el('button', { type: 'button', role: 'tab', 'data-key': d.key, onclick: () => show(d.key) }, d.label));
  show(initial && defs.some((d) => d.key === initial) ? initial : defs[0].key);
  return { node: el('div', { class: 'mtabs-wrap' }, bar, body), show };
}

function field(label, input, hint) {
  return el('label', {}, label, input, hint ? el('span', { class: 'muted small field-hint' }, hint) : null);
}
function inputOf(type, value, attrs = {}) {
  const i = type === 'textarea' ? el('textarea', Object.assign({ rows: 3 }, attrs)) : el('input', Object.assign({ type }, attrs));
  i.value = value ?? '';
  return i;
}
function selectOf(options, value) {
  const s = el('select', {}, ...options.map(([v, l]) => el('option', { value: String(v) }, l)));
  s.value = String(value ?? '');
  if (s.selectedIndex < 0 && options.length) s.append(el('option', { value: String(value) }, String(value)));
  s.value = String(value ?? '');
  return s;
}
const closeBtn = () => el('button', { class: 'primary', onclick: () => closeModal() }, 'Schließen');

/** Channels as indented options ("— Unterkanal"). */
function channelOptions(exclude = new Set()) {
  const out = [];
  const walk = (parent, depth) => {
    for (const ch of sortedChildren(parent)) {
      if (exclude.has(ch.id)) continue;
      out.push([ch.id, ' '.repeat(depth) + ch.name.replace(SPACER_RE, (m, a, t) => t || '—')]);
      walk(ch.id, depth + 1);
    }
  };
  walk(0, 0);
  return out;
}
function descendants(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const ch of S.channels.values()) if (out.has(ch.parent) && !out.has(ch.id)) { out.add(ch.id); grew = true; }
  }
  return out;
}

/** Pick a client: online users or a database id / unique id. Resolves with a database id. */
async function resolveClientDbId(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Bitte einen Nutzer angeben');
  if (/^\d+$/.test(t)) return Number(t);
  const online = [...S.clients.values()].find((c) => c.uid === t || c.name === t);
  if (online && online.database_id) return online.database_id;
  const data = await adm('clientgetdbidfromuid', { cluid: t });
  const r = items(data, 'notifyclientdbidfromuid')[0];
  if (!r || !r.cldbid) throw new Error('Unbekannte eindeutige ID');
  return Number(r.cldbid);
}
function clientPicker() {
  const dl = el('datalist', { id: 'adm-clients-' + (++ADM.seq) });
  for (const c of [...S.clients.values()].filter((c) => !c.is_query).sort((a, b) => a.name.localeCompare(b.name))) {
    dl.append(el('option', { value: c.uid || String(c.database_id) }, c.name));
  }
  const input = el('input', { type: 'text', list: dl.id, placeholder: 'Nutzer wählen, eindeutige ID oder Datenbank-ID' });
  return { input, node: el('div', {}, input, dl) };
}
const onlineByDb = (dbid) => [...S.clients.values()].find((c) => c.database_id === Number(dbid));

// ---------------------------------------------------------------- management window
function openManage(tab = 'server') {
  const tv = tabView([
    { key: 'server', label: 'Server', render: serverPane },
    { key: 'sgroups', label: 'Servergruppen', render: (p) => groupsPane(p, 'server') },
    { key: 'cgroups', label: 'Kanalgruppen', render: (p) => groupsPane(p, 'channel') },
    { key: 'bans', label: 'Bans', render: bansPane },
    { key: 'tokens', label: 'Schlüssel', render: tokensPane },
    { key: 'complaints', label: 'Beschwerden', render: complaintsPane },
    { key: 'temppw', label: 'Temp. Passwörter', render: tempPwPane },
  ], tab);
  openModal('Serververwaltung', tv.node, [closeBtn()], { wide: true });
}

// ---------------------------------------------------------------- server settings
const SERVER_FIELDS = [
  ['Allgemein', [
    ['name', 'Servername', 'text'],
    ['name_phonetic', 'Phonetischer Name', 'text'],
    ['welcomemessage', 'Willkommensnachricht (BBCode)', 'textarea'],
    ['maxclients', 'Max. Benutzer (Slots)', 'number'],
    ['reserved_slots', 'Reservierte Slots', 'number'],
  ]],
  ['Host-Nachricht', [
    ['hostmessage', 'Nachricht', 'textarea'],
    ['hostmessage_mode', 'Anzeige', 'select', [[0, 'Nicht anzeigen'], [1, 'Im Chat-Log'], [2, 'Als Fenster'], [3, 'Als Fenster, danach Verbindung trennen']]],
  ]],
  ['Host-Banner', [
    ['hostbanner_url', 'Link beim Klick', 'text'],
    ['hostbanner_gfx_url', 'Bild-URL', 'text'],
    ['hostbanner_gfx_interval', 'Bild neu laden alle … Sekunden (0 = nie)', 'number'],
    ['hostbanner_mode', 'Größe', 'select', [[0, 'Nicht anpassen'], [1, 'Anpassen, Seitenverhältnis ignorieren'], [2, 'Anpassen, Seitenverhältnis behalten']]],
  ]],
  ['Host-Button', [
    ['hostbutton_tooltip', 'Tooltip', 'text'],
    ['hostbutton_url', 'Link', 'text'],
    ['hostbutton_gfx_url', 'Icon-URL', 'text'],
  ]],
  ['Standardgruppen', [
    ['default_server_group', 'Servergruppe für neue Nutzer', 'sgroup'],
    ['default_channel_group', 'Kanalgruppe für Nutzer', 'cgroup'],
    ['default_channel_admin_group', 'Kanalgruppe für Kanalersteller', 'cgroup'],
  ]],
  ['Sicherheit', [
    ['needed_identity_security_level', 'Benötigtes Sicherheitslevel der Identität', 'number'],
    ['codec_encryption_mode', 'Sprachverschlüsselung', 'select', [[0, 'Pro Kanal einstellbar'], [1, 'Überall aus'], [2, 'Überall an']]],
  ]],
  ['Anti-Flood', [
    ['antiflood_points_tick_reduce', 'Abbau pro Sekunde', 'number'],
    ['antiflood_points_needed_command_block', 'Punkte bis zur Befehlssperre', 'number'],
    ['antiflood_points_needed_ip_block', 'Punkte bis zur IP-Sperre', 'number'],
  ]],
  ['Beschwerden', [
    ['complain_autoban_count', 'Automatischer Bann ab … Beschwerden', 'number'],
    ['complain_autoban_time', 'Dauer des automatischen Banns (Sekunden)', 'number'],
    ['complain_remove_time', 'Beschwerden löschen nach … Sekunden', 'number'],
  ]],
  ['Dateiübertragung', [
    ['max_download_total_bandwidth', 'Max. Download gesamt (Byte/s, 18446744073709551615 = unbegrenzt)', 'text'],
    ['max_upload_total_bandwidth', 'Max. Upload gesamt (Byte/s)', 'text'],
    ['download_quota', 'Download-Kontingent pro Monat (MiB)', 'text'],
    ['upload_quota', 'Upload-Kontingent pro Monat (MiB)', 'text'],
  ]],
  ['Sonstiges', [
    ['priority_speaker_dimm_modificator', 'Andere leiser bei Priority Speaker (dB, z. B. -18)', 'text'],
    ['min_clients_in_channel_before_forced_silence', 'Erzwungene Stille ab … Nutzern im Kanal', 'number'],
    ['channel_temp_delete_delay_default', 'Standard-Löschverzögerung temporärer Kanäle (Sekunden)', 'number'],
    ['weblist_enabled', 'In der öffentlichen TeamSpeak-Serverliste anzeigen', 'check'],
  ]],
  ['Protokollierung', [
    ['log_client', 'Clients', 'check'], ['log_query', 'ServerQuery', 'check'], ['log_channel', 'Kanäle', 'check'],
    ['log_permissions', 'Rechte', 'check'], ['log_server', 'Server', 'check'], ['log_filetransfer', 'Dateiübertragung', 'check'],
  ]],
];

async function serverPane(pane) {
  pane.append(el('p', { class: 'muted small' }, 'Einstellungen werden geladen…'));
  let vars, sgroups = [], cgroups = [];
  try {
    const data = await adm('servergetvariables');
    vars = Object.assign({}, items(data, 'bridge_server')[0] || {}, items(data, 'notifyserverupdated')[0] || {});
    [sgroups, cgroups] = await Promise.all([serverGroups().catch(() => []), channelGroups().catch(() => [])]);
  } catch (e) {
    pane.replaceChildren(el('div', { class: 'alert error' }, e.message));
    return;
  }
  const form = el('form', { class: 'adm-form' });
  const inputs = new Map();
  const initial = new Map();
  const val = (k) => vars['virtualserver_' + k];
  for (const [title, fields] of SERVER_FIELDS) {
    const sec = el('fieldset', {}, el('legend', {}, title));
    for (const [key, label, type, opts] of fields) {
      const cur = val(key);
      if (cur === undefined) continue; // the server did not send it (missing permission to view)
      let input;
      if (type === 'check') input = el('input', { type: 'checkbox', checked: cur === '1' });
      else if (type === 'select') input = selectOf(opts, cur);
      else if (type === 'sgroup') input = selectOf(sgroups.filter((g) => g.type === 1).map((g) => [g.id, g.name]), cur);
      else if (type === 'cgroup') input = selectOf(cgroups.filter((g) => g.type === 1).map((g) => [g.id, g.name]), cur);
      else input = inputOf(type, cur, type === 'number' ? { step: 1 } : {});
      inputs.set(key, input);
      initial.set(key, type === 'check' ? cur === '1' : String(cur));
      sec.append(type === 'check' ? el('label', { class: 'check' }, input, label) : field(label, input));
    }
    if (title === 'Allgemein') {
      const hasPw = val('flag_password') === '1';
      const change = el('input', { type: 'checkbox' });
      const pw = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'leer = kein Passwort', disabled: true });
      change.addEventListener('change', () => { pw.disabled = !change.checked; if (change.checked) pw.focus(); });
      inputs.set('password', { pw, change });
      sec.append(el('label', { class: 'check' }, change, `Serverpasswort ändern (derzeit ${hasPw ? 'mit' : 'ohne'} Passwort)`), pw);
    }
    if (sec.children.length > 1) form.append(sec);
  }
  const save = el('button', { type: 'submit', class: 'primary' }, 'Server speichern');
  form.append(el('div', { class: 'adm-actions' }, save));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const params = {};
    for (const [key, input] of inputs) {
      if (key === 'password') { if (input.change.checked) params.virtualserver_password = input.pw.value; continue; }
      const now = input.type === 'checkbox' ? input.checked : String(input.value).trim();
      if (now === initial.get(key)) continue;
      params['virtualserver_' + key] = typeof now === 'boolean' ? (now ? 1 : 0) : now;
    }
    if (!Object.keys(params).length) { toast('Nichts geändert'); return; }
    busy(save, async () => {
      await adm('serveredit', params);
      for (const [key, input] of inputs) if (key !== 'password') initial.set(key, input.type === 'checkbox' ? input.checked : String(input.value).trim());
      const pw = inputs.get('password');
      if (pw && pw.change.checked) { pw.change.checked = false; pw.pw.value = ''; pw.pw.disabled = true; }
      toast('Server gespeichert');
    });
  });
  pane.replaceChildren(form);
}

// ---------------------------------------------------------------- groups
function groupsPane(pane, kind) {
  const isServer = kind === 'server';
  const idKey = isServer ? 'sgid' : 'cgid';
  const pfx = isServer ? 'servergroup' : 'channelgroup';
  const showAll = el('input', { type: 'checkbox' });
  const list = el('div', { class: 'glist' });
  const detail = el('div', { class: 'gdetail' }, el('p', { class: 'muted small' }, 'Gruppe auswählen.'));
  const add = el('button', { type: 'button' }, '+ Neue Gruppe');
  let groups = [];
  let current = null;

  const load = async (force = true) => {
    list.replaceChildren(el('p', { class: 'muted small' }, 'Wird geladen…'));
    try { groups = await (isServer ? serverGroups(force) : channelGroups(force)); } catch (e) { list.replaceChildren(el('div', { class: 'alert error' }, e.message)); return; }
    renderList();
    if (current) { const g = groups.find((x) => x.id === current); if (g) select(g); else { current = null; detail.replaceChildren(el('p', { class: 'muted small' }, 'Gruppe auswählen.')); } }
  };
  const typeLabel = (t) => ({ 0: 'Vorlage', 2: 'Query' }[t] || '');
  const renderList = () => {
    list.replaceChildren(...groups.filter((g) => showAll.checked || g.type === 1).map((g) => el('button', {
      type: 'button', class: 'gitem' + (g.id === current ? ' active' : ''), onclick: () => select(g),
    }, el('span', {}, g.name), typeLabel(g.type) ? el('span', { class: 'muted small' }, typeLabel(g.type)) : el('span', { class: 'muted small' }, `#${g.id}`))));
  };
  const select = (g) => {
    current = g.id;
    renderList();
    const rename = el('button', { type: 'button' }, 'Umbenennen');
    const copy = el('button', { type: 'button' }, 'Kopieren');
    const del = el('button', { type: 'button', class: 'danger' }, 'Löschen');
    rename.addEventListener('click', async () => {
      const name = await promptInline('Neuer Name', g.name);
      if (name && name !== g.name) busy(rename, async () => { await adm(pfx + 'rename', { [idKey]: g.id, name }); await load(); toast('Umbenannt'); });
    });
    copy.addEventListener('click', async () => {
      const name = await promptInline('Name der Kopie', g.name + ' (Kopie)');
      if (name) busy(copy, async () => { await adm(pfx + 'copy', isServer ? { ssgid: g.id, tsgid: 0, name, type: 1 } : { scgid: g.id, tcgid: 0, name, type: 1 }); await load(); toast('Gruppe kopiert'); });
    });
    del.addEventListener('click', async () => {
      if (!await confirmDialog(`Die Gruppe „${g.name}“ wird gelöscht, auch wenn sie noch Mitglieder hat.`, { title: 'Gruppe löschen?', okLabel: 'Löschen', danger: true })) return;
      busy(del, async () => { await adm(pfx + 'del', { [idKey]: g.id, force: 1 }); current = null; await load(); detail.replaceChildren(el('p', { class: 'muted small' }, 'Gruppe gelöscht.')); });
    });
    const tv = tabView([
      { key: 'perms', label: 'Rechte', render: (p) => p.append(permEditor({
        skip: isServer, negate: isServer,
        hint: isServer ? 'Skip: Kanal- und Kanalgruppenrechte überschreiben den Wert nicht. Negieren: es gilt der niedrigste Wert aller Gruppen. Grant: nötige Stärke, um das Recht zu vergeben.' : 'Grant: nötige Stärke, um das Recht zu vergeben.',
        load: async () => permRows(await adm(pfx + 'permlist', { [idKey]: g.id }), `notify${pfx}permlist`),
        set: (permid, v) => adm(pfx + 'addperm', isServer
          ? { sgid: g.id, permid, permvalue: v.value, permnegated: v.negated ? 1 : 0, permskip: v.skip ? 1 : 0 }
          : { cgid: g.id, permid, permvalue: v.value }),
        del: (permid) => adm(pfx + 'delperm', { [idKey]: g.id, permid }),
      })) },
      { key: 'members', label: 'Mitglieder', render: (p) => (isServer ? serverGroupMembers(p, g) : channelGroupMembers(p, g)) },
    ], 'perms');
    detail.replaceChildren(el('div', { class: 'ghead' }, el('strong', {}, g.name), el('span', { class: 'muted small' }, `ID ${g.id}`), el('div', { class: 'gbtns' }, rename, copy, del)), tv.node);
  };
  add.addEventListener('click', async () => {
    const name = await promptInline('Name der neuen Gruppe', '');
    if (name) busy(add, async () => { await adm(pfx + 'add', { name, type: 1 }); await load(); toast('Gruppe erstellt'); });
  });
  showAll.addEventListener('change', renderList);
  pane.append(el('div', { class: 'split' },
    el('div', { class: 'gside' }, add, list, el('label', { class: 'check small' }, showAll, 'Vorlagen und Query-Gruppen zeigen')),
    detail));
  load(false);
}

/** A small inline prompt (keeps the management window open). */
function promptInline(label, value) {
  return new Promise((resolve) => {
    const bd = $('#confirm-backdrop');
    const input = el('input', { type: 'text' });
    input.value = value || '';
    const done = (v) => { bd.hidden = true; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(null); }
      if (e.key === 'Enter' && e.target === input) { e.preventDefault(); done(input.value.trim()); }
    };
    const card = $('#confirm-card');
    card.className = 'card confirm';
    card.textContent = '';
    card.append(el('div', { class: 'confirm-icon', html: ICON.info }), el('div', { class: 'confirm-body' },
      el('h2', {}, label), input,
      el('div', { class: 'confirm-buttons' }, el('button', { onclick: () => done(null) }, 'Abbrechen'), el('button', { class: 'primary', onclick: () => done(input.value.trim()) }, 'OK'))));
    bd.onclick = (e) => { if (e.target === bd) done(null); };
    document.addEventListener('keydown', onKey, true);
    bd.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

async function serverGroupMembers(pane, g) {
  const list = el('div', { class: 'mlist' });
  const picker = clientPicker();
  const addBtn = el('button', { type: 'button', class: 'primary' }, 'Hinzufügen');
  const load = async () => {
    list.replaceChildren(el('p', { class: 'muted small' }, 'Wird geladen…'));
    try {
      const rows = items(await adm('servergroupclientlist', { sgid: g.id }, ['-names']), 'notifyservergroupclientlist').filter((r) => r.cldbid);
      list.replaceChildren(...(rows.length ? rows.map((r) => {
        const on = onlineByDb(r.cldbid);
        const rm = el('button', { type: 'button', class: 'danger small-btn' }, 'Entfernen');
        rm.addEventListener('click', () => busy(rm, async () => { await adm('servergroupdelclient', { sgid: g.id, cldbid: r.cldbid }); load(); }));
        return el('div', { class: 'mrow' }, el('div', {}, el('strong', {}, r.client_nickname || on?.name || `DB-ID ${r.cldbid}`), on ? el('span', { class: 'online-dot', title: 'online' }) : null,
          el('div', { class: 'muted small' }, `DB-ID ${r.cldbid}`, r.client_unique_identifier ? ' · ' + r.client_unique_identifier : '')), rm);
      }) : [el('p', { class: 'muted small' }, 'Keine Mitglieder.')]));
    } catch (e) { list.replaceChildren(el('div', { class: 'alert error' }, e.message)); }
  };
  addBtn.addEventListener('click', () => busy(addBtn, async () => {
    const cldbid = await resolveClientDbId(picker.input.value);
    await adm('servergroupaddclient', { sgid: g.id, cldbid });
    picker.input.value = '';
    load();
  }));
  pane.append(el('div', { class: 'add-row' }, picker.node, addBtn), list);
  load();
}

async function channelGroupMembers(pane, g) {
  const list = el('div', { class: 'mlist' });
  const picker = clientPicker();
  const chSel = selectOf(channelOptions(), S.clients.get(S.ownId)?.channel);
  const addBtn = el('button', { type: 'button', class: 'primary' }, 'Zuweisen');
  const load = async () => {
    list.replaceChildren(el('p', { class: 'muted small' }, 'Wird geladen…'));
    try {
      const rows = items(await adm('channelgroupclientlist', { cgid: g.id }), 'notifychannelgroupclientlist').filter((r) => r.cldbid && r.cid);
      list.replaceChildren(...(rows.length ? rows.map((r) => {
        const on = onlineByDb(r.cldbid);
        const rm = el('button', { type: 'button', class: 'danger small-btn' }, 'Entfernen');
        rm.addEventListener('click', () => busy(rm, async () => {
          await adm('setclientchannelgroup', { cgid: S.server.default_channel_group, cid: r.cid, cldbid: r.cldbid });
          load();
        }));
        return el('div', { class: 'mrow' }, el('div', {}, el('strong', {}, on?.name || `DB-ID ${r.cldbid}`), on ? el('span', { class: 'online-dot', title: 'online' }) : null,
          el('div', { class: 'muted small' }, `Kanal: ${S.channels.get(Number(r.cid))?.name || '#' + r.cid} · DB-ID ${r.cldbid}`)), rm);
      }) : [el('p', { class: 'muted small' }, 'Niemand hat diese Kanalgruppe.')]));
    } catch (e) { list.replaceChildren(el('div', { class: 'alert error' }, e.message)); }
  };
  addBtn.addEventListener('click', () => busy(addBtn, async () => {
    const cldbid = await resolveClientDbId(picker.input.value);
    await adm('setclientchannelgroup', { cgid: g.id, cid: Number(chSel.value), cldbid });
    picker.input.value = '';
    load();
  }));
  pane.append(el('div', { class: 'add-row' }, picker.node, chSel, addBtn), list);
  load();
}

// ---------------------------------------------------------------- bans
const BAN_TIMES = [[3600, '1 Stunde'], [86400, '1 Tag'], [604800, '7 Tage'], [2592000, '30 Tage'], [0, 'Permanent']];

function bansPane(pane) {
  const list = el('div', { class: 'mlist' });
  const ip = el('input', { type: 'text', placeholder: 'z. B. 203.0.113.7' });
  const name = el('input', { type: 'text', placeholder: 'Regulärer Ausdruck, z. B. ^Spammer.*' });
  const uid = el('input', { type: 'text', placeholder: 'z. B. abc123…=' });
  const time = selectOf(BAN_TIMES, 86400);
  const reason = el('input', { type: 'text' });
  const addBtn = el('button', { type: 'submit', class: 'primary' }, 'Bann hinzufügen');
  const form = el('form', { class: 'adm-form' }, el('fieldset', {}, el('legend', {}, 'Neuer Bann'),
    el('p', { class: 'muted small' }, 'Mindestens eins von IP, Name oder eindeutiger ID. Webnutzer haben auf dem TeamSpeak die IP der Brücke – sperre sie über die eindeutige ID (oder in /admin), sonst trifft es alle Webnutzer.'),
    el('div', { class: 'grid2' }, field('IP-Adresse', ip), field('Nickname', name), field('Eindeutige ID', uid), field('Dauer', time)),
    field('Grund', reason), el('div', { class: 'adm-actions' }, addBtn)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = { time: Number(time.value), banreason: reason.value.trim() };
    if (ip.value.trim()) p.ip = ip.value.trim();
    if (name.value.trim()) p.name = name.value.trim();
    if (uid.value.trim()) p.uid = uid.value.trim();
    if (!p.ip && !p.name && !p.uid) { toast('IP, Name oder eindeutige ID angeben', 'error'); return; }
    busy(addBtn, async () => { await adm('banadd', p); ip.value = name.value = uid.value = reason.value = ''; load(); toast('Bann hinzugefügt'); });
  });
  const load = async () => {
    list.replaceChildren(el('p', { class: 'muted small' }, 'Wird geladen…'));
    try {
      const rows = items(await adm('banlist'), 'notifybanlist').filter((b) => b.banid);
      list.replaceChildren(...(rows.length ? rows.map((b) => {
        const rm = el('button', { type: 'button', class: 'danger small-btn' }, 'Aufheben');
        rm.addEventListener('click', () => busy(rm, async () => { await adm('bandel', { banid: b.banid }); load(); }));
        const target = [b.ip && `IP ${b.ip}`, b.name && `Name ${b.name}`, b.uid && `ID ${b.uid}`, b.lastnickname && `(zuletzt „${b.lastnickname}“)`].filter(Boolean).join(' · ');
        const end = Number(b.duration) ? fmtDate(Number(b.created) + Number(b.duration)) : 'nie';
        return el('div', { class: 'mrow' }, el('div', {}, el('strong', {}, target || `Bann #${b.banid}`),
          el('div', { class: 'muted small' }, `Grund: ${b.reason || '–'} · Dauer: ${fmtSecs(b.duration)} · endet: ${end}`),
          el('div', { class: 'muted small' }, `von ${b.invokername || '–'} am ${fmtDate(b.created)} · ${b.enforcements || 0}× gegriffen`)), rm);
      }) : [el('p', { class: 'muted small' }, 'Keine Banns.')]));
    } catch (e) { list.replaceChildren(el('div', { class: 'alert error' }, e.message)); }
  };
  pane.append(form, el('h3', {}, 'Bannliste'), list);
  load();
}

// ---------------------------------------------------------------- privilege keys
function tokensPane(pane) {
  const list = el('div', { class: 'mlist' });
  const type = selectOf([[0, 'Servergruppe'], [1, 'Kanalgruppe']], 0);
  const group = el('select');
  const chan = selectOf(channelOptions(), S.clients.get(S.ownId)?.channel);
  const chanField = field('Kanal', chan);
  const desc = el('input', { type: 'text' });
  const addBtn = el('button', { type: 'submit', class: 'primary' }, 'Schlüssel erstellen');
  const result = el('div');
  const fillGroups = async () => {
    const isServer = type.value === '0';
    chanField.hidden = isServer;
    try {
      const gs = (isServer ? await serverGroups() : await channelGroups()).filter((g) => g.type === 1);
      group.replaceChildren(...gs.map((g) => el('option', { value: String(g.id) }, g.name)));
    } catch (e) { fail(e); }
  };
  type.addEventListener('change', fillGroups);
  const form = el('form', { class: 'adm-form' }, el('fieldset', {}, el('legend', {}, 'Neuer Berechtigungsschlüssel'),
    el('div', { class: 'grid2' }, field('Art', type), field('Gruppe', group), chanField, field('Beschreibung', desc)),
    el('div', { class: 'adm-actions' }, addBtn), result));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!group.value) return;
    const isServer = type.value === '0';
    busy(addBtn, async () => {
      const data = await adm('privilegekeyadd', { tokentype: Number(type.value), tokenid1: Number(group.value), tokenid2: isServer ? 0 : Number(chan.value), tokendescription: desc.value.trim() });
      const tok = items(data, 'notifytokenadd')[0]?.token;
      result.replaceChildren(tok ? tokenBox(tok) : el('p', { class: 'muted small' }, 'Schlüssel erstellt.'));
      desc.value = '';
      load();
    });
  });
  const load = async () => {
    list.replaceChildren(el('p', { class: 'muted small' }, 'Wird geladen…'));
    try {
      const [rows, sg, cg] = await Promise.all([
        adm('privilegekeylist').then((d) => items(d, 'notifytokenlist').filter((t) => t.token)),
        serverGroups().catch(() => []), channelGroups().catch(() => [])]);
      list.replaceChildren(...(rows.length ? rows.map((t) => {
        const rm = el('button', { type: 'button', class: 'danger small-btn' }, 'Löschen');
        rm.addEventListener('click', () => busy(rm, async () => { await adm('privilegekeydelete', { token: t.token }); load(); }));
        const isServer = t.token_type === '0';
        const what = isServer ? `Servergruppe „${groupName(sg, t.token_id1)}“` : `Kanalgruppe „${groupName(cg, t.token_id1)}“ in ${S.channels.get(Number(t.token_id2))?.name || '#' + t.token_id2}`;
        return el('div', { class: 'mrow' }, el('div', { class: 'grow' }, tokenBox(t.token), el('div', { class: 'muted small' }, `${what} · erstellt ${fmtDate(t.token_created)}${t.token_description ? ' · ' + t.token_description : ''}`)), rm);
      }) : [el('p', { class: 'muted small' }, 'Keine offenen Schlüssel.')]));
    } catch (e) { list.replaceChildren(el('div', { class: 'alert error' }, e.message)); }
  };
  pane.append(form, el('h3', {}, 'Offene Schlüssel'), list);
  fillGroups();
  load();
}

function tokenBox(tok) {
  const copy = el('button', { type: 'button', class: 'small-btn' }, 'Kopieren');
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(tok); toast('Kopiert'); } catch { toast('Kopieren nicht möglich', 'error'); } });
  return el('div', { class: 'token-box' }, el('code', {}, tok), copy);
}

// ---------------------------------------------------------------- complaints
function complaintsPane(pane) {
  const list = el('div', { class: 'mlist' });
  const load = async () => {
    list.replaceChildren(el('p', { class: 'muted small' }, 'Wird geladen…'));
    try {
      const rows = items(await adm('complainlist'), 'notifycomplainlist').filter((c) => c.tcldbid);
      list.replaceChildren(...(rows.length ? rows.map((c) => {
        const rm = el('button', { type: 'button', class: 'danger small-btn' }, 'Löschen');
        rm.addEventListener('click', () => busy(rm, async () => { await adm('complaindel', { tcldbid: c.tcldbid, fcldbid: c.fcldbid }); load(); }));
        return el('div', { class: 'mrow' }, el('div', {}, el('strong', {}, `${c.fname || 'DB-ID ' + c.fcldbid} über ${c.tname || 'DB-ID ' + c.tcldbid}`),
          el('div', {}, c.message || ''), el('div', { class: 'muted small' }, fmtDate(c.timestamp))), rm);
      }) : [el('p', { class: 'muted small' }, 'Keine Beschwerden.')]));
    } catch (e) { list.replaceChildren(el('div', { class: 'alert error' }, e.message)); }
  };
  pane.append(list);
  load();
}

// ---------------------------------------------------------------- temporary passwords
function tempPwPane(pane) {
  const list = el('div', { class: 'mlist' });
  const pw = el('input', { type: 'text' });
  const desc = el('input', { type: 'text' });
  const dur = selectOf([[3600, '1 Stunde'], [21600, '6 Stunden'], [86400, '1 Tag'], [604800, '7 Tage']], 86400);
  const chan = selectOf([[0, '(Standardkanal)'], ...channelOptions()], 0);
  const cpw = el('input', { type: 'text', placeholder: 'falls der Kanal ein Passwort hat' });
  const addBtn = el('button', { type: 'submit', class: 'primary' }, 'Passwort anlegen');
  const form = el('form', { class: 'adm-form' }, el('fieldset', {}, el('legend', {}, 'Neues temporäres Serverpasswort'),
    el('p', { class: 'muted small' }, 'Damit kommt jemand eine Zeit lang auf den Server, ohne das eigentliche Serverpasswort zu kennen.'),
    el('div', { class: 'grid2' }, field('Passwort', pw), field('Gültig für', dur), field('Beschreibung', desc), field('Zielkanal', chan), field('Kanalpasswort', cpw)),
    el('div', { class: 'adm-actions' }, addBtn)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pw.value.trim()) { toast('Passwort fehlt', 'error'); return; }
    busy(addBtn, async () => {
      await adm('servertemppasswordadd', { pw: pw.value.trim(), desc: desc.value.trim(), duration: Number(dur.value), tcid: Number(chan.value), tcpw: cpw.value });
      pw.value = desc.value = cpw.value = '';
      load();
    });
  });
  const load = async () => {
    list.replaceChildren(el('p', { class: 'muted small' }, 'Wird geladen…'));
    try {
      const rows = items(await adm('servertemppasswordlist'), 'notifyservertemppasswordlist').filter((r) => r.pw_clear != null);
      list.replaceChildren(...(rows.length ? rows.map((r) => {
        const rm = el('button', { type: 'button', class: 'danger small-btn' }, 'Löschen');
        rm.addEventListener('click', () => busy(rm, async () => { await adm('servertemppassworddel', { pw: r.pw_clear }); load(); }));
        return el('div', { class: 'mrow' }, el('div', {}, el('code', {}, r.pw_clear), ' ', r.desc || '',
          el('div', { class: 'muted small' }, `von ${r.nickname || '–'} · gültig bis ${fmtDate(r.end)}${Number(r.tcid) ? ' · Kanal ' + (S.channels.get(Number(r.tcid))?.name || r.tcid) : ''}`)), rm);
      }) : [el('p', { class: 'muted small' }, 'Keine temporären Passwörter.')]));
    } catch (e) { list.replaceChildren(el('div', { class: 'alert error' }, e.message)); }
  };
  pane.append(form, el('h3', {}, 'Aktive Passwörter'), list);
  load();
}

// ---------------------------------------------------------------- channel editor
const CODECS = [[0, 'Speex Schmalband (8 kHz)'], [1, 'Speex Breitband (16 kHz)'], [2, 'Speex Ultra-Breitband (32 kHz)'], [3, 'CELT Mono (48 kHz)'], [4, 'Opus Voice (Sprache)'], [5, 'Opus Music (Musik, Stereo)']];
const CODEC_NUM = { SpeexNarrowband: 0, SpeexWideband: 1, SpeexUltrawideband: 2, CeltMono: 3, OpusVoice: 4, OpusMusic: 5 };

function openChannelEditor(id, tab = 'general') {
  const ch = S.channels.get(id);
  if (!ch) return;
  if (ch.description == null) send({ t: 'channel_description', channel: id });

  const name = inputOf('text', ch.name, { maxlength: 40 });
  const phonetic = inputOf('text', ch.phonetic_name);
  const topic = inputOf('text', ch.topic);
  const desc = inputOf('textarea', ch.description ?? '', { rows: 6, placeholder: ch.description == null ? 'Beschreibung wird geladen…' : '' });
  const pwChange = el('input', { type: 'checkbox' });
  const pw = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'leer = kein Passwort', disabled: true });
  pwChange.addEventListener('change', () => { pw.disabled = !pwChange.checked; if (pwChange.checked) pw.focus(); });

  const codec = selectOf(CODECS, CODEC_NUM[ch.codec] ?? 4);
  const quality = selectOf([...Array(11).keys()].map((q) => [q, String(q)]), ch.codec_quality);
  const latency = selectOf([...Array(10).keys()].map((q) => [q + 1, q === 0 ? '1 (geringste Verzögerung)' : String(q + 1)]), ch.codec_latency_factor || 1);
  const unenc = el('input', { type: 'checkbox', checked: ch.is_unencrypted });

  const kind = selectOf([['temporary', 'Temporär (wird gelöscht, wenn leer)'], ['semi_permanent', 'Semi-permanent (bis zum Serverneustart)'], ['permanent', 'Permanent']], ch.kind);
  const isDefault = el('input', { type: 'checkbox', checked: ch.is_default, disabled: ch.is_default });
  const maxMode = selectOf([['unlimited', 'Unbegrenzt'], ['limited', 'Begrenzt']], ch.max_clients >= 0 ? 'limited' : 'unlimited');
  const maxN = inputOf('number', ch.max_clients >= 0 ? ch.max_clients : 10, { min: 0, step: 1 });
  const famMode = selectOf([['inherited', 'Vom übergeordneten Kanal übernehmen'], ['unlimited', 'Unbegrenzt'], ['limited', 'Begrenzt']], ch.max_family_clients >= 0 ? 'limited' : ch.max_family_clients === -2 ? 'inherited' : 'unlimited');
  const famN = inputOf('number', ch.max_family_clients >= 0 ? ch.max_family_clients : 20, { min: 0, step: 1 });
  const talk = inputOf('number', ch.needed_talk_power, { step: 1 });
  const delay = inputOf('number', ch.delete_delay, { min: 0, step: 1 });
  const sync = () => { maxN.disabled = maxMode.value !== 'limited'; famN.disabled = famMode.value !== 'limited'; };
  maxMode.addEventListener('change', sync); famMode.addEventListener('change', sync); sync();

  // fill the description once it arrived (unless the user already typed)
  let poll = null;
  if (ch.description == null) {
    let tries = 0;
    poll = setInterval(() => {
      const c = S.channels.get(id);
      if (c && c.description != null) { if (!desc.value) desc.value = c.description; desc.placeholder = ''; clearInterval(poll); }
      else if (++tries > 40) { desc.placeholder = ''; clearInterval(poll); }
    }, 250);
  }

  const tv = tabView([
    { key: 'general', label: 'Allgemein', render: (p) => p.append(field('Name', name), field('Phonetischer Name', phonetic), field('Thema', topic),
      field('Beschreibung (BBCode)', desc), el('label', { class: 'check' }, pwChange, `Passwort ändern (derzeit ${ch.has_password ? 'mit' : 'ohne'} Passwort)`), pw) },
    { key: 'audio', label: 'Audio', render: (p) => p.append(field('Codec', codec), field('Qualität (0–10)', quality, 'Höher = besserer Klang, mehr Bandbreite. Opus Voice 6 ≈ 40 kbit/s.'),
      field('Latenzfaktor', latency, 'Höher = weniger Pakete, aber mehr Verzögerung.'), el('label', { class: 'check' }, unenc, 'Sprache unverschlüsselt übertragen')) },
    { key: 'advanced', label: 'Erweitert', render: (p) => p.append(field('Kanaltyp', kind), el('label', { class: 'check' }, isDefault, 'Standardkanal (hier landen neue Nutzer)'),
      el('div', { class: 'grid2' }, field('Max. Nutzer', maxMode), field('Anzahl', maxN), field('Max. Nutzer inkl. Unterkanäle', famMode), field('Anzahl', famN)),
      field('Benötigte Talk Power zum Sprechen', talk, '0 = jeder darf sprechen.'),
      field('Löschverzögerung (Sekunden)', delay, 'Wie lange ein temporärer Kanal nach dem letzten Nutzer bestehen bleibt.')) },
    { key: 'perms', label: 'Rechte', render: (p) => p.append(permEditor({
      hint: 'Kanalrechte gelten für alle Nutzer in diesem Kanal, z. B. i_channel_needed_join_power.',
      load: async () => permRows(await adm('channelpermlist', { cid: id }), 'notifychannelpermlist'),
      set: (permid, v) => adm('channeladdperm', { cid: id, permid, permvalue: v.value }),
      del: (permid) => adm('channeldelperm', { cid: id, permid }),
    })) },
  ], tab);

  const save = el('button', { class: 'primary', type: 'button' }, 'Speichern');
  save.addEventListener('click', () => {
    const p = {};
    const cur = S.channels.get(id) || ch;
    if (name.value.trim() && name.value !== cur.name) p.channel_name = name.value;
    if (phonetic.value !== (cur.phonetic_name || '')) p.channel_name_phonetic = phonetic.value;
    if (topic.value !== (cur.topic || '')) p.channel_topic = topic.value;
    if (cur.description != null ? desc.value !== cur.description : desc.value !== '') p.channel_description = desc.value;
    if (pwChange.checked) { p.channel_password = pw.value; p.channel_flag_password = pw.value ? 1 : 0; }
    if (Number(codec.value) !== CODEC_NUM[cur.codec]) p.channel_codec = Number(codec.value);
    if (Number(quality.value) !== cur.codec_quality) p.channel_codec_quality = Number(quality.value);
    if (Number(latency.value) !== (cur.codec_latency_factor || 1)) p.channel_codec_latency_factor = Number(latency.value);
    if (unenc.checked !== cur.is_unencrypted) p.channel_codec_is_unencrypted = unenc.checked ? 1 : 0;
    if (kind.value !== cur.kind) {
      p.channel_flag_permanent = kind.value === 'permanent' ? 1 : 0;
      p.channel_flag_semi_permanent = kind.value === 'semi_permanent' ? 1 : 0;
    }
    if (isDefault.checked && !cur.is_default) p.channel_flag_default = 1;
    const maxNow = maxMode.value === 'limited' ? Math.max(0, Math.trunc(num(maxN.value))) : -1;
    if (maxNow !== cur.max_clients) {
      if (maxNow < 0) p.channel_flag_maxclients_unlimited = 1;
      else { p.channel_flag_maxclients_unlimited = 0; p.channel_maxclients = maxNow; }
    }
    const famNow = famMode.value === 'limited' ? Math.max(0, Math.trunc(num(famN.value))) : famMode.value === 'inherited' ? -2 : -1;
    if (famNow !== cur.max_family_clients) {
      p.channel_flag_maxfamilyclients_inherited = famNow === -2 ? 1 : 0;
      p.channel_flag_maxfamilyclients_unlimited = famNow === -1 ? 1 : 0;
      if (famNow >= 0) p.channel_maxfamilyclients = famNow;
    }
    if (Math.trunc(num(talk.value)) !== cur.needed_talk_power) p.channel_needed_talk_power = Math.trunc(num(talk.value));
    if (Math.trunc(num(delay.value)) !== cur.delete_delay) p.channel_delete_delay = Math.max(0, Math.trunc(num(delay.value)));
    if (!Object.keys(p).length) { closeModal(); return; }
    busy(save, async () => { await adm('channeledit', Object.assign({ cid: id }, p)); toast('Kanal gespeichert'); closeModal(); });
  });
  openModal(`„${ch.name}“ bearbeiten`, tv.node, [el('button', { onclick: () => closeModal() }, 'Abbrechen'), save], { wide: true });
  if (poll) S.onModalClose = () => clearInterval(poll);
}

function openChannelMove(id) {
  const ch = S.channels.get(id);
  if (!ch) return;
  const parent = selectOf([[0, '(Oberste Ebene)'], ...channelOptions(descendants(id))], ch.parent);
  const after = el('select');
  const fill = () => {
    const sibs = sortedChildren(Number(parent.value)).filter((c) => c.id !== id);
    after.replaceChildren(el('option', { value: '0' }, 'Ganz oben'), ...sibs.map((c) => el('option', { value: String(c.id) }, `Nach „${c.name}“`)));
    after.value = Number(parent.value) === ch.parent && sibs.some((c) => c.id === ch.order) ? String(ch.order) : (sibs.length ? String(sibs[sibs.length - 1].id) : '0');
  };
  parent.addEventListener('change', fill);
  fill();
  const ok = el('button', { class: 'primary', type: 'button' }, 'Verschieben');
  ok.addEventListener('click', () => busy(ok, async () => {
    await adm('channelmove', { cid: id, cpid: Number(parent.value), order: Number(after.value) });
    toast('Kanal verschoben');
    closeModal();
  }));
  openModal(`„${ch.name}“ verschieben`, el('div', {}, field('Übergeordneter Kanal', parent), field('Position', after)),
    [el('button', { onclick: () => closeModal() }, 'Abbrechen'), ok]);
}

// ---------------------------------------------------------------- client management
async function openClientServerGroups(c) {
  const body = el('div', {}, el('p', { class: 'muted small' }, 'Wird geladen…'));
  openModal(`Servergruppen von ${c.name}`, body, [closeBtn()]);
  try {
    const [groups, mine] = await Promise.all([serverGroups(), adm('servergroupsbyclientid', { cldbid: c.database_id })]);
    const have = new Set(items(mine, 'notifyservergroupsbyclientid').map((g) => Number(g.sgid)));
    body.replaceChildren(el('p', { class: 'muted small' }, 'Haken setzen oder entfernen – die Änderung gilt sofort.'),
      ...groups.filter((g) => g.type === 1).map((g) => {
        const cb = el('input', { type: 'checkbox', checked: have.has(g.id) });
        cb.disabled = g.id === S.server.default_server_group;
        cb.addEventListener('change', async () => {
          cb.disabled = true;
          try {
            await adm(cb.checked ? 'servergroupaddclient' : 'servergroupdelclient', { sgid: g.id, cldbid: c.database_id });
          } catch (e) { fail(e); cb.checked = !cb.checked; }
          cb.disabled = false;
        });
        return el('label', { class: 'check' }, cb, g.name, g.id === S.server.default_server_group ? el('span', { class: 'muted small' }, ' (Standardgruppe)') : null);
      }));
  } catch (e) { body.replaceChildren(el('div', { class: 'alert error' }, e.message)); }
}

async function openClientChannelGroup(c) {
  const body = el('div', {}, el('p', { class: 'muted small' }, 'Wird geladen…'));
  const ok = el('button', { class: 'primary', type: 'button', disabled: true }, 'Zuweisen');
  openModal(`Kanalgruppe von ${c.name}`, body, [el('button', { onclick: () => closeModal() }, 'Abbrechen'), ok]);
  try {
    const groups = (await channelGroups()).filter((g) => g.type === 1);
    const chan = selectOf(channelOptions(), c.channel);
    const cur = groups.find((g) => g.name === c.channel_group);
    const grp = selectOf(groups.map((g) => [g.id, g.name]), cur ? cur.id : S.server.default_channel_group);
    body.replaceChildren(field('Kanal', chan), field('Kanalgruppe', grp));
    ok.disabled = false;
    ok.addEventListener('click', () => busy(ok, async () => {
      await adm('setclientchannelgroup', { cgid: Number(grp.value), cid: Number(chan.value), cldbid: c.database_id });
      toast('Kanalgruppe gesetzt');
      closeModal();
    }));
  } catch (e) { body.replaceChildren(el('div', { class: 'alert error' }, e.message)); }
}

function openClientPerms(c, tab = 'client') {
  const chId = c.channel;
  const tv = tabView([
    { key: 'client', label: 'Nutzerrechte', render: (p) => p.append(permEditor({
      skip: true,
      hint: 'Rechte nur für diesen Nutzer (über seine Identität, gilt auch nach dem Neuverbinden).',
      load: async () => permRows(await adm('clientpermlist', { cldbid: c.database_id }), 'notifyclientpermlist'),
      set: (permid, v) => adm('clientaddperm', { cldbid: c.database_id, permid, permvalue: v.value, permskip: v.skip ? 1 : 0 }),
      del: (permid) => adm('clientdelperm', { cldbid: c.database_id, permid }),
    })) },
    { key: 'channel', label: `Im Kanal „${S.channels.get(chId)?.name || chId}“`, render: (p) => p.append(permEditor({
      hint: 'Rechte nur für diesen Nutzer und nur in diesem Kanal.',
      load: async () => permRows(await adm('channelclientpermlist', { cid: chId, cldbid: c.database_id }), 'notifychannelclientpermlist'),
      set: (permid, v) => adm('channelclientaddperm', { cid: chId, cldbid: c.database_id, permid, permvalue: v.value }),
      del: (permid) => adm('channelclientdelperm', { cid: chId, cldbid: c.database_id, permid }),
    })) },
  ], tab);
  openModal(`Rechte von ${c.name}`, tv.node, [closeBtn()], { wide: true });
}

function openBanClient(c) {
  const time = selectOf(BAN_TIMES, 86400);
  const reason = el('input', { type: 'text' });
  const ok = el('button', { class: 'danger-solid', type: 'button' }, 'Bannen');
  ok.addEventListener('click', () => busy(ok, async () => {
    await adm('banclient', { clid: c.id, time: Number(time.value), banreason: reason.value.trim() });
    toast(`${c.name} wurde gebannt`);
    closeModal();
  }));
  openModal(`${c.name} bannen`, el('div', {}, field('Dauer', time), field('Grund', reason)), [el('button', { onclick: () => closeModal() }, 'Abbrechen'), ok]);
}

function toggleTalker(c) {
  adm('clientedit', { clid: c.id, client_is_talker: c.talk_power_granted ? 0 : 1 })
    .then(() => toast(c.talk_power_granted ? 'Talk Power entzogen' : 'Talk Power erteilt'), fail);
}

/** Entries for the context menu of a client. */
function clientAdminItems(c) {
  const isMe = c.id === S.ownId;
  return [
    '-',
    { label: 'Servergruppen…', action: () => openClientServerGroups(c) },
    { label: 'Kanalgruppe…', action: () => openClientChannelGroup(c) },
    { label: 'Rechte…', action: () => openClientPerms(c) },
    !isMe && !c.is_query && { label: c.talk_power_granted ? 'Talk Power entziehen' : 'Talk Power erteilen', action: () => toggleTalker(c) },
    !isMe && { label: 'Bannen…', danger: true, action: () => openBanClient(c) },
  ];
}
