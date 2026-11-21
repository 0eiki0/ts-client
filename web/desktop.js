'use strict';
/* Funkraum desktop app: update bar and the "Programm" section in the settings.
 * Talks to the app through wry's window.ipc; the app calls
 * window.funkraum.update(state) with the current update state. */
(() => {
  const post = (m) => { try { window.ipc && window.ipc.postMessage(JSON.stringify(m)); } catch { /* ignore */ } };
  let state = { state: 'idle' };
  let dismissed = null; // the version the user put off with "Später"

  const bar = document.createElement('div');
  bar.id = 'update-bar';
  bar.setAttribute('role', 'status');
  bar.hidden = true;
  document.body.append(bar);

  const button = (text, cls, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', onClick);
    return b;
  };

  function renderBar() {
    const s = state;
    const show = (s.state === 'available' && dismissed !== s.new) || s.state === 'installing'
      || s.state === 'installed' || s.state === 'failed';
    bar.hidden = !show;
    bar.className = s.state === 'failed' ? 'error' : '';
    bar.replaceChildren();
    if (!show) return;
    const text = document.createElement('div');
    text.className = 'update-text';
    const buttons = document.createElement('div');
    buttons.className = 'update-buttons';
    if (s.state === 'available') {
      text.innerHTML = '<strong>Neue Version von Funkraum verfügbar.</strong> Möchtest du sie jetzt installieren?';
      buttons.append(
        button('Jetzt aktualisieren', 'primary', () => post({ t: 'update-install' })),
        button('Später', '', () => { dismissed = s.new; renderBar(); }),
      );
    } else if (s.state === 'installing') {
      text.innerHTML = '<strong>Update wird geladen und installiert…</strong> Du kannst weiter sprechen.';
    } else if (s.state === 'installed') {
      text.innerHTML = '<strong>Update installiert.</strong> Starte Funkraum neu, um die neue Version zu benutzen. Eine laufende Verbindung wird dabei kurz getrennt.';
      buttons.append(
        button('Jetzt neu starten', 'primary', () => post({ t: 'restart' })),
        button('Später', '', () => { bar.hidden = true; }),
      );
    } else if (s.state === 'failed') {
      text.textContent = 'Das Update konnte nicht installiert werden: ' + (s.reason || 'unbekannter Fehler') + '. Du kannst die neue Version selbst herunterladen.';
      buttons.append(
        button('Download öffnen', 'primary', () => post({ t: 'open-releases' })),
        button('Schließen', '', () => { bar.hidden = true; }),
      );
    }
    bar.append(text, buttons);
  }

  // Settings → "Programm": version and "Nach Updates suchen"
  function renderSettings() {
    const v = document.getElementById('s-app-version');
    const info = document.getElementById('s-app-update-info');
    const check = document.getElementById('s-app-update');
    if (!v || !info || !check) return;
    // Only write when something changed: the observer below sees our own writes.
    const set = (el, text) => { if (el.textContent !== text) el.textContent = text; };
    set(v, `${state.version || ''} (Build ${state.build || '?'})`);
    if (!check.dataset.wired) {
      check.dataset.wired = '1';
      check.addEventListener('click', () => post({ t: 'update-check' }));
    }
    const s = state.state;
    const disabled = s === 'checking' || s === 'installing' || state.enabled === false;
    if (check.disabled !== disabled) check.disabled = disabled;
    set(info, ({
      idle: state.enabled === false ? 'Automatische Updates sind für diesen Build ausgeschaltet.' : 'Funkraum sucht regelmäßig nach neuen Versionen und fragt dich vor dem Installieren.',
      checking: 'Suche nach Updates…',
      current: 'Funkraum ist aktuell.',
      available: 'Eine neue Version ist verfügbar – siehe Hinweis oben im Fenster.',
      installing: 'Update wird installiert…',
      installed: 'Update installiert – beim nächsten Start aktiv.',
      failed: 'Update fehlgeschlagen: ' + (state.reason || ''),
      'check-failed': 'Suche fehlgeschlagen: ' + (state.reason || ''),
      disabled: 'Automatische Updates sind für diesen Build ausgeschaltet.',
    })[s] || '');
  }

  window.funkraum = {
    update(s) {
      state = s || state;
      // A manual check shows an existing update again even after "Später".
      if (state.state === 'available' && document.getElementById('s-app-update')) dismissed = null;
      renderBar();
      renderSettings();
    },
  };

  // The settings dialog is built from a template each time it opens.
  new MutationObserver(renderSettings).observe(document.body, { childList: true, subtree: true });
  post({ t: 'hello' });
})();
