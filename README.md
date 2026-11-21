# TS Client

Ein **TeamSpeak-Client für Windows, macOS und Linux**: herunterladen, starten, Serveradresse eingeben, losreden.

Der Client hat dieselbe Oberfläche wie die [TS3 Web Bridge](https://github.com/0eiki0/ts3-webbridge), läuft aber als eigenes Programm. Er verbindet sich direkt per UDP mit dem TeamSpeak-Server, eine Brücke dazwischen braucht es nicht. Er funktioniert mit TeamSpeak-3-Servern und mit [ts-server](https://github.com/0eiki0/ts-server).

## Download

Unter **[Releases](https://github.com/0eiki0/ts-client/releases)** (Release „latest“):

| System | Datei |
|---|---|
| Windows 10/11 | `TS-Client-Windows.exe` |
| macOS 11+ (Intel und Apple Silicon) | `TS-Client-macOS.zip` – entpacken, `TS Client.app` in „Programme“ ziehen |
| Linux (x86_64) | `TS-Client-Linux-x86_64` – `chmod +x` und starten |

### Beim ersten Start

Das Programm ist nicht mit einem gekauften Zertifikat signiert, deshalb warnen Windows und macOS beim ersten Start:

- **Windows:** „Der Computer wurde durch Windows geschützt“ → *Weitere Informationen* → *Trotzdem ausführen*
- **macOS:** Rechtsklick auf die App → *Öffnen* → *Öffnen*. Bei neueren macOS-Versionen erscheint dafür unter *Systemeinstellungen → Datenschutz & Sicherheit* der Knopf *Dennoch öffnen*.
- **Linux:** braucht WebKitGTK 4.1 und GTK 3 (bei Ubuntu/Debian: `sudo apt install libwebkit2gtk-4.1-0`; bei den meisten Desktops schon installiert).

Beim ersten Verbinden fragt das System nach dem **Mikrofon**.

## Funktionen

Alles aus der Weboberfläche der TS3 Web Bridge:
- Kanäle, Chat und Anstupsen
- Push-to-Talk, Sprachaktivierung, Rauschfilter
- Lautstärke pro Nutzer, mehrere Identitäten (auch aus dem TS3-Client importierbar)
- Serververwaltung und Rechte-Editor

Dazu kommt:

- **Globales Push-to-Talk:** Die Sprechtaste wirkt auch, wenn das Fenster im Hintergrund ist, z. B. im Spiel. Das gilt ebenso für die anderen Tastenkürzel (Mikrofon/Lautsprecher stumm, Abwesend). Die Taste stellst du wie gewohnt unter *Einstellungen → Tastenkürzel* ein.
  - **Windows:** Tastatur und Maustasten (auch die Seitentasten)
  - **macOS:** Tastatur und mittlere Maustaste. macOS fragt beim ersten Start nach der Erlaubnis für **Bedienungshilfen**: *Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen* → „TS Client“ einschalten, dann die App neu starten.
  - **Linux:** Tastatur und mittlere Maustaste unter X11. Unter Wayland werden nur Tasten erkannt, die in X11-Programmen gedrückt werden.
- Identitäten und Einstellungen bleiben auf dem Rechner gespeichert:
  - Windows: `%LOCALAPPDATA%\ts-client`
  - macOS: `~/Library/Application Support/ts-client`
  - Linux: `~/.local/share/ts-client`

  Dort liegt auch die Protokolldatei `ts-client.log`.

## Wie es funktioniert

```
Fenster (System-Webansicht) ──WebSocket──▶ lokaler Server 127.0.0.1:47213 ──TS3-Protokoll (UDP)──▶ TeamSpeak-Server
```

Das Programm startet einen kleinen Server nur auf `127.0.0.1` und zeigt dessen Oberfläche in einem Fenster an. Dafür nutzt es die Webansicht des Systems: WebView2 unter Windows, WebKit unter macOS und Linux. Andere Programme oder Webseiten im Browser dürfen diesen Server nicht benutzen, er prüft die Absender-Adresse jeder Anfrage. Das TeamSpeak-Protokoll spricht [tsclientlib](https://github.com/ReSpeak/tsclientlib), eine inoffizielle Open-Source-Nachimplementierung.

## Selbst bauen

Voraussetzungen: Rust (stable), `cmake`, unter Linux zusätzlich `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev`.

```bash
cargo build --release
./target/release/ts-client          # -v für ausführliche Protokolle
```

GitHub Actions baut bei jedem Push auf `main` alle drei Systeme und veröffentlicht sie als Release **„latest“**. Ein Tag wie `v1.0.0` erzeugt ein Release mit Versionsnummer.

## Aufbau

| Datei | Inhalt |
|---|---|
| `src/main.rs` | Start, Fenster (tao/wry), Mikrofon-Freigabe, Weitergabe der globalen Tasten |
| `src/hotkeys.rs` | Globales Push-to-Talk: Tastatur und Maus des Systems abfragen |
| `src/web.rs` | Lokaler Server: Oberfläche, Identitäten, WebSocket; Schutz gegen fremde Zugriffe |
| `src/session.rs`, `src/protocol.rs`, `src/capture.rs`, `src/resolve.rs`, `src/versions.rs` | Aus der TS3 Web Bridge: TeamSpeak-Verbindung, Audio, Befehle |
| `src/admin.rs`, `src/query.rs`, `src/bans.rs` | Platzhalter für Teile der Brücke, die es nur auf dem Server gibt |
| `web/` | Oberfläche (aus der TS3 Web Bridge) |
| `packaging/Info.plist` | macOS-App (Mikrofon-Hinweis) |

## Lizenz

MIT. Enthält RNNoise (siehe `third_party/rnnoise-wasm`) und die Liste signierter TS3-Client-Versionen (`third_party/ts-versions`, MIT).
