# Funkraum

Ein **TeamSpeak-Client für Windows, macOS und Linux**: herunterladen, starten, Serveradresse eingeben, losreden.

Der Client hat dieselbe Oberfläche wie [Funkraum Web](https://github.com/0eiki0/ts3-webbridge), läuft aber als eigenes Programm. Er verbindet sich direkt per UDP mit dem TeamSpeak-Server, eine Brücke dazwischen braucht es nicht. Er funktioniert mit TeamSpeak-3-Servern und mit [Funkraum Server](https://github.com/0eiki0/ts-server).

> **Hinweis:** TeamSpeak ist eine eingetragene Marke der TeamSpeak Systems GmbH. Funkraum ist ein unabhängiges Open-Source-Projekt und steht in keiner Verbindung zu TeamSpeak Systems; es wird von ihr weder unterstützt noch geprüft. „TeamSpeak“ wird hier nur verwendet, um zu beschreiben, mit welchen Servern das Programm funktioniert.

## Download

Unter **[Releases](https://github.com/0eiki0/ts-client/releases)** (Release „latest“):

| System | Datei |
|---|---|
| Windows 10/11 | `Funkraum-Windows.exe` |
| macOS 11+ (Intel und Apple Silicon) | `Funkraum-macOS.zip` – entpacken, `Funkraum.app` in „Programme“ ziehen |
| Linux (x86_64) | `Funkraum-Linux-x86_64` – `chmod +x` und starten |

### Updates

Funkraum sucht beim Start und danach alle 6 Stunden nach einer neuen Version im Release „latest“. Gibt es eine, erscheint oben im Fenster ein Hinweis **„Neue Version verfügbar – Jetzt aktualisieren / Später“**. Erst wenn du zustimmst, wird die neue Version geladen, mit der Prüfsumme (`.sha256`) geprüft und installiert. Danach kannst du Funkraum mit **„Jetzt neu starten“** direkt neu starten (eine laufende Verbindung wird dabei kurz getrennt) oder später.

- Unter *Einstellungen → Programm* stehen die installierte Version und der Knopf **„Nach Updates suchen“**.
- Klappt die Installation nicht (z. B. keine Schreibrechte im Programmordner), öffnet **„Download öffnen“** die Download-Seite.
- Kommandozeile: `funkraum --update` sucht und installiert ohne Rückfrage; mit `--no-update` oder `FUNKRAUM_NO_UPDATE=1` sucht Funkraum gar nicht.

### Beim ersten Start

Das Programm ist nicht mit einem gekauften Zertifikat signiert, deshalb warnen Windows und macOS beim ersten Start:

- **Windows:** „Der Computer wurde durch Windows geschützt“ → *Weitere Informationen* → *Trotzdem ausführen*
- **macOS:** Rechtsklick auf die App → *Öffnen* → *Öffnen*. Bei neueren macOS-Versionen erscheint dafür unter *Systemeinstellungen → Datenschutz & Sicherheit* der Knopf *Dennoch öffnen*.
- **Linux:** braucht WebKitGTK 4.1 und GTK 3 (bei Ubuntu/Debian: `sudo apt install libwebkit2gtk-4.1-0`; bei den meisten Desktops schon installiert).

Beim ersten Verbinden fragt das System nach dem **Mikrofon**.

## Funktionen

Alles aus der Weboberfläche von Funkraum Web:
- Kanäle, Chat und Anstupsen
- Push-to-Talk, Sprachaktivierung, Rauschfilter
- Lautstärke pro Nutzer, mehrere Identitäten (auch aus dem TeamSpeak-3-Client importierbar)
- Serververwaltung und Rechte-Editor

Dazu kommt:

- **Globales Push-to-Talk:** Die Sprechtaste wirkt auch, wenn das Fenster im Hintergrund ist, z. B. im Spiel. Das gilt ebenso für die anderen Tastenkürzel (Mikrofon/Lautsprecher stumm, Abwesend). Die Taste stellst du wie gewohnt unter *Einstellungen → Tastenkürzel* ein.
  - **Windows:** Tastatur und Maustasten (auch die Seitentasten)
  - **macOS:** Tastatur und mittlere Maustaste. macOS fragt beim ersten Start nach der Erlaubnis für **Bedienungshilfen**: *Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen* → „Funkraum“ einschalten, dann die App neu starten.
  - **Linux:** Tastatur und mittlere Maustaste unter X11. Unter Wayland werden nur Tasten erkannt, die in X11-Programmen gedrückt werden.
- **Benachrichtigungen** bei Anstupsern und privaten Nachrichten als normale Systembenachrichtigung (Windows: Absender „Funkraum“), einschalten unter *Einstellungen → Desktop-Benachrichtigungen*.
- **Serveradressen mit SRV-Eintrag** (`_ts3._udp.example.com`) werden wie im TeamSpeak-Programm aufgelöst. Antwortet das DNS des Systems nicht, fragt die App zusätzlich Cloudflare und Google.
- Identitäten und Einstellungen bleiben auf dem Rechner gespeichert:
  - Windows: `%LOCALAPPDATA%\funkraum`
  - macOS: `~/Library/Application Support/funkraum`
  - Linux: `~/.local/share/funkraum`

  Dort liegt auch die Protokolldatei `funkraum.log`.

## Wie es funktioniert

```
Fenster (System-Webansicht) ──WebSocket──▶ lokaler Server 127.0.0.1:47213 ──TeamSpeak-3-Protokoll (UDP)──▶ TeamSpeak-Server
```

Das Programm startet einen kleinen Server nur auf `127.0.0.1` und zeigt dessen Oberfläche in einem Fenster an. Dafür nutzt es die Webansicht des Systems: WebView2 unter Windows, WebKit unter macOS und Linux. Andere Programme oder Webseiten im Browser dürfen diesen Server nicht benutzen, er prüft die Absender-Adresse jeder Anfrage. Das TeamSpeak-Protokoll spricht [tsclientlib](https://github.com/ReSpeak/tsclientlib), eine inoffizielle Open-Source-Nachimplementierung.

## Selbst bauen

Voraussetzungen: Rust (stable), `cmake`, unter Linux zusätzlich `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev`.

```bash
cargo build --release
./target/release/funkraum          # -v für ausführliche Protokolle
```

GitHub Actions baut bei jedem Push auf `main` alle drei Systeme und veröffentlicht sie als Release **„latest“**. Ein Tag wie `v1.0.0` erzeugt ein Release mit Versionsnummer.

## Aufbau

| Datei | Inhalt |
|---|---|
| `src/main.rs` | Start, Fenster (tao/wry), Mikrofon-Freigabe, Weitergabe der globalen Tasten |
| `src/updater.rs` | Automatische Updates aus dem GitHub-Release „latest“ |
| `src/notify.rs` | Desktop-Benachrichtigungen (an das System weitergeleitet) |
| `src/hotkeys.rs` | Globales Push-to-Talk: Tastatur und Maus des Systems abfragen |
| `src/web.rs` | Lokaler Server: Oberfläche, Identitäten, WebSocket; Schutz gegen fremde Zugriffe |
| `src/session.rs`, `src/protocol.rs`, `src/capture.rs`, `src/resolve.rs`, `src/versions.rs` | Aus Funkraum Web: TeamSpeak-Verbindung, Audio, Befehle |
| `src/admin.rs`, `src/query.rs`, `src/bans.rs` | Platzhalter für Teile der Brücke, die es nur auf dem Server gibt |
| `web/` | Oberfläche (aus Funkraum Web) |
| `packaging/Info.plist` | macOS-App (Mikrofon-Hinweis) |

## Lizenz

MIT. Enthält RNNoise (siehe `third_party/rnnoise-wasm`) und die Liste signierter TeamSpeak-3-Client-Versionen (`third_party/ts-versions`, MIT).
