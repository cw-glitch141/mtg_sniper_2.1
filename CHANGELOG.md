# Changelog

Format: neueste Version oben. Jede Version nennt auch ihre **offenen Einschränkungen**.

## 2.2.0 – Live-Deal-Radar (2026-11-04)

### Neu
- **Listing-Feed-Schnittstelle** (`server/src/providers/listings.ts`) mit Quelle, Autorisierung, Cardmarket-Produkt,
  Finish, Angebots-ID, Verkäufer, Preis, Währung, Zustand, Sprache, Menge, Porto, Link, Quell-Zeitstempel, Abruf- und
  Ablaufzeit. Health-Daten: Läufe, Fehler, Rate-Limits, Abdeckung.
- **CardTrader-Adapter** (offizielle API v2, eigenes Token). Er wird nur aktiv mit `CARDTRADER_TOKEN`,
  `live.cardtrader.enabled` und `live.cardtrader.termsConfirmed`. Zuordnung über `card_market_ids`, Rate-Begrenzung
  (Standard 4/s), Abbruch bei HTTP 429, Budget je Lauf.
- **Live-Radar** (`server/src/services/liveRadar.ts`):
  - dynamische Zielmenge
  - Rundlauf-Polling
  - Grundlinie ohne Alarme
  - Erkennung neuer Angebots-IDs und belegter Preisänderungen
  - Validierung (Ablehnen bzw. Prüfen)
  - Ereignisprotokoll mit gemessener Verzögerung
  - Alarme mit Angebotslink, Preis, Porto, Zustand, Sprache, Edition, Verkäufer, Beobachtungszeit, konservativem
    Gewinn und Confidence
- **TEST-Feed** (`MTGDS_MOCK_FEED=1`): erzeugt ausschließlich SIMULATION-Daten.
- Dashboard-Seite **Live-Radar**, Feed-Status in Seitenleiste, Übersicht, Kaufchancen und Datenquellen.
- **Qualitätsbericht** (`npm run report`, `scripts/daily-quality.ps1`) und **SYSTEM-Alarme** an den Betreiber bei Import-
  oder Feed-Ausfall und veralteten Daten.
- CI-Workflow (Typprüfung, Tests, Build; bei Push, PR und nachts), PR- und Issue-Vorlagen, Labels, `docs/user-stories.md`,
  `docs/datenquellen.md`, `docs/github.md`.

### Geändert (Korrektur irreführender Anzeigen)
- Marktsignale (Price-Dip, Volatilität, Tiefstpreis) haben keinen Einkaufspreis mehr, sondern einen **hypothetischen
  Modellwert**. Alarme, CSV-Export und Market Watch zeigen für sie weder Einkauf noch Gewinn.
- „Trading Opportunities“ heißt jetzt **Kaufchancen** und zeigt nur Angebote. Die Ranglisten der Übersicht stützen sich
  nur auf Angebote.
- „KAUFEN“ nur bei vollständigem, frischem Angebot, dessen konservatives Szenario die Mindestwerte erreicht. Sonst „PRÜFEN“.
- Kennzeichen **VERALTET** und **TEST** zusätzlich zur Signalklasse.
- Kauf eines Live-Angebots nur mit Bestätigung „vor der Zahlung auf der Angebotsseite geprüft“ (`confirmedAvailable`).
  Marktsignale können nicht als gekauft erfasst werden.
- Fremde Währungen werden beim Angebotseingang abgelehnt (keine stille Umrechnung).
- `start.cmd` baut das Dashboard bei jedem Start, damit nach Updates keine alte Oberfläche ausgeliefert wird.
- `.gitignore` schließt Datenbanken, Logs, ZIP-Backups, Berichte und Schlüsseldateien aus.

### Datenbank
- Migration 3, rein additiv, mit automatischer Sicherung vorher. Getestet auf einer Kopie der echten Datenbank
  (125.255 Produkte).

### Tests
- 91 Tests (vorher 77). Neue Suite `server/test/live.test.ts`. Drei bestehende Tests nutzten Testangebote ohne Link;
  ihre Testdaten enthalten jetzt den Link, den die echte Erweiterung mitsendet (`extension/shared.js`).

### Offene Einschränkungen
- **Kein Live-Feed verbunden.** Der CardTrader-Adapter ist gegen recherchierte Antwortformen getestet, nicht gegen die
  echte API. Die offizielle Referenz und die Nutzungsbedingungen waren für automatische Abrufe gesperrt (403).
  Feldnamen, Linkformat und Limits sind beim ersten echten Lauf zu bestätigen.
- Noch **kein Nachweis mit realen Angebots-IDs** und keine gemessene Live-Verzögerung (US-04, Daten: offen).
- Cardmarket-Angebote werden nicht automatisch überwacht (keine API-Zulassung möglich).
- CardTrader liefert kein Porto je Angebot (Schätzung, gekennzeichnet) und keinen bekannten Deeplink je Angebot.
- Extension-Tests (headless Chrome) laufen nur lokal, nicht in CI.

## 2.1.0 – Business Edition (2026-11-04)
- Einkauf, Lager-Chargen (FIFO), Verkaufsaufträge, Versand, Kapital-Ledger, Limits als Kaufregeln, Repricing,
  Prioritäten HIGH/MEDIUM/WATCH, Profit Analytics und Strategievalidierung (Details im README).
