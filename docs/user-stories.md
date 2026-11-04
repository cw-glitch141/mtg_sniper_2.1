# User Stories und Backlog – Live-Deal-Radar

Jede Story wird erst als erledigt markiert, wenn ihre Tests grün sind und die Akzeptanzkriterien (AK) nachweisbar
erfüllt sind. Zwei Fragen werden **getrennt** bewertet:

- **Funktion**: Ist der Code da und getestet?
- **Daten**: Liefert eine echte, autorisierte Quelle tatsächlich Daten?

„Adapter implementiert“ ist nicht dasselbe wie „Live-Feed angeschlossen“.

Personas:

- **Händler**: kauft unterbewertete Karten und verkauft sie weiter.
- **Betreiber**: dieselbe Person in der Rolle, die die Software betreibt.

Prioritäten: P1 = muss, P2 = soll, P3 = kann.
Labels (GitHub): `bug`, `data-quality`, `api`, `live-listings`, `profit`, `regression`, `security`, `usability`, `blocked-by-provider`.

| Story | Priorität | Funktion | Daten | Labels |
|---|---|---|---|---|
| US-01 | P1 | ✅ erledigt | – (keine Quelle nötig) | `live-listings`, `data-quality` |
| US-02 | P1 | ✅ erledigt | Extension ✅, CardTrader ⏳ unverifiziert | `data-quality`, `api` |
| US-03 | P1 | ✅ erledigt | – | `profit` |
| US-04 | P1 | ✅ erledigt (Adapter + Engine) | ⛔ kein autorisierter Feed verbunden | `live-listings`, `api`, `blocked-by-provider` |
| US-05 | P1 | ✅ erledigt | – | `data-quality` |
| US-06 | P1 | ✅ erledigt (CI-Workflow) | – | `regression` |
| US-07 | P2 | ✅ erledigt | – | `data-quality` |
| US-08 | P1 | ✅ erledigt | – | `regression`, `usability` |

---

## US-01 – Nur echte, frische Kaufangebote

**Als** Händler **will ich** in der Kaufchancenliste nur echte, frische Angebote sehen, **damit** ich keine
Phantommargen kaufe.

- Abhängige Datenquelle: keine (die Regel wirkt auf alle Quellen)
- AK:
  - Ein Price-Guide-Wert ohne Angebots-ID oder Link erscheint niemals als Live-Deal oder Kaufchance.
  - Der Feed-Status wird angezeigt (Live-Radar, Übersicht, Seitenleiste).
  - „KAUFEN“ gibt es nur für LIVE_OFFER, das vollständig, frisch und im konservativen Szenario rentabel ist.
- Testfälle:
  - `pipeline.test.ts` › *Marktsignale werden nie als KAUFEN empfohlen*
  - `live.test.ts` › *Market Watch: Marktsignale ohne Einkaufspreis und Gewinn …*
  - `live.test.ts` › *Ohne Feed: ehrliche Meldung, keine automatischen Live-Angebote*
- DoD: Die Kaufchancen-Seite filtert fest auf Angebote, Marktsignale stehen nur unter Market Watch, die Tests sind grün.

## US-02 – Exakte Karte mit Edition, Sprache, Zustand, Finish

**Als** Händler **will ich** zu jedem Angebot die exakte Karte samt Edition, Sprache, Zustand und Finish sehen.

- Abhängige Datenquelle: Extension (Cardmarket-Seite) und Listing-Feeds (CardTrader über `card_market_ids`)
- AK:
  - Fehlen Pflichtfelder (Verkäufer, Link, Zustand, Sprache, bei Feeds die Angebots-ID), wird das Angebot auf „PRÜFEN“
    gesetzt, nicht auf „KAUFEN“.
  - Abgelehnt werden: fremde Währung, Verkäufer im Urlaub, falsches Finish, Menge 0.
  - Signiert, altered, gegradet oder Bündel → zur Prüfung.
- Testfälle: `live.test.ts`:
  - *Angebot ohne Link → nur PRÜFEN …*
  - *Abbildung: Zustand, Sprache, Finish, Flags, Preis in Cent*
  - *Fremde Währung wird beim Eingang abgelehnt*
- DoD: Tests grün. Zuordnung über die Cardmarket-idProduct, der Namensabgleich nur bei eindeutigem Treffer.
- Offen: Die CardTrader-Feldnamen müssen beim ersten echten Lauf bestätigt werden (`blocked-by-provider`, bis ein Token vorliegt).

## US-03 – Nachweisbare Netto-Margen statt Rabatte

**Als** Händler **will ich** nachweisbare Netto-Margen sehen statt bloßer Rabatte.

- AK:
  - Einkauf, Porto (angegeben oder geschätzt, gekennzeichnet), Verkaufsgebühr, Verpackung, Arbeitszeit, Risiko,
    Steuermodus und ROI sind einzeln nachvollziehbar (Rechenweg im Detail).
  - Konservatives Szenario wird getrennt angezeigt; Mindestwerte `live.minConservativeProfit` und
    `live.minConservativeRoiPct` sind einstellbar.
- Testfälle: `profit.test.ts` (Profit-Engine), `analytics.test.ts` › *Live-Angebot, das alle Regeln erfüllt …*,
  `api.test.ts` › *Gesamtablauf …* (realisierter Deckungsbeitrag 16,50 €)
- DoD: Tests grün; Marktsignale zeigen keine Gewinne (nur eine eingeklappte, „hypothetisch“ bezeichnete Rechnung).

## US-04 – Neue oder reduzierte Listings zeitnah

**Als** Händler **will ich** neue oder reduzierte Angebote zeitnah gemeldet bekommen.

- Abhängige Datenquelle: **autorisierter Listing-Feed** (derzeit nur CardTrader mit eigenem Token)
- AK:
  - Neue Angebots-ID (nach der Grundlinie) oder belegte Preissenkung erzeugt ein Ereignis mit Zeitstempel und Link.
  - Deduplizierung: Unverändertes erzeugt keinen Alarm; Cooldown gilt je Angebot und Preis.
  - Die Feed-Latenz wird gemessen und angezeigt: exakt nur mit Quell-Zeitstempel, sonst als Obergrenze.
  - Ohne autorisierten Feed steht dort wörtlich: „Automatische Cardmarket-Angebotsüberwachung nicht verfügbar – keine
    Live-Datenquelle verbunden“.
- Testfälle: `live.test.ts`:
  - *CardTrader: Grundlinie ohne Alarm, danach neues Angebot + Preissenkung …*
  - *Rate-Limit (HTTP 429) …*
  - *TEST-Feed erzeugt nur SIMULATION …*
- DoD Funktion: ✅. DoD Daten: ⛔ erst erfüllt, wenn mit einem echten Token reale Angebots-IDs und mindestens ein
  beobachtetes neues oder reduziertes Angebot nachgewiesen sind (Eintrag im CHANGELOG mit Datum, Anzahl, Latenz).

## US-05 – Ausfälle und Datenalter sofort merken

**Als** Betreiber **will ich** sofort merken, wenn ein Import oder Preisdaten ausfallen oder altern.

- AK:
  - Health-Status je Quelle (Datenstand, Alter, letzter Erfolg, Fehler) und je Feed (Läufe, Fehler, Rate-Limits, Abdeckung).
  - Bei kritischen Befunden gibt es einen SYSTEM-Alarm an den Betreiber (Dashboard, optional Telegram/Discord),
    höchstens einmal je Befund und Tag.
- Testfälle: `pipeline.test.ts` › *Ausfall einer Quelle wird protokolliert …*,
  `live.test.ts` › *Fehlgeschlagener Price-Guide-Import erzeugt einen SYSTEM-Alarm*
- DoD: Tests grün; die Prüfung läuft nach jedem Zeitplan-Lauf und jeder Feed-Abfrage.

## US-06 – Änderungen zerstören keine alten Funktionen

**Als** Betreiber **will ich**, dass Änderungen keine bestehenden Funktionen zerstören.

- AK:
  - Pflicht-Checks (`npm run typecheck`, `npm test`, `npm run build`) laufen bei jedem Push und Pull Request
    (`.github/workflows/ci.yml`) und nachts.
  - Merge in `main` nur mit grünen Checks (Branch-Protection, siehe `docs/github.md`).
  - Migrationen sind nur additiv, vor jeder Migration wird automatisch gesichert.
- Testfälle: gesamte Suite. `live.test.ts` › *Migration 3 ist additiv*
- DoD: Workflow vorhanden. Branch-Protection muss der Besitzer in GitHub aktivieren (abhängig vom Tarif).

## US-07 – Täglicher Qualitätsbericht

**Als** Betreiber **will ich** einen täglichen Qualitätsbericht.

- AK: Der Bericht erfasst:
  - Datenfrische und Feed-Ausfälle
  - Teststatus und neue Fehler
  - Anzahl der Signale nach Klasse
  - Fehlalarm-Indikatoren
  - Trends gegenüber dem Vorbericht
  - priorisierte Vorschläge

  Er ändert nie Code oder Daten.
- Umsetzung:
  - `npm run report` (CLI)
  - `scripts/daily-quality.ps1`: führt Tests und Typprüfung aus, erzeugt den Bericht und legt ihn als Markdown unter
    `data/reports/` ab.
  - Dashboard: Live-Radar › Qualitätsbericht
- Testfälle: `live.test.ts` › *Qualitätsbericht: Befunde priorisiert …*
- DoD: Tests grün; der tägliche Lauf ist per Windows-Aufgabenplanung eingerichtet (Befehl in `docs/github.md`).

## US-08 – Die Extension bleibt nutzbar

**Als** Nutzer **will ich** die bestehende Erweiterung weiter nutzen können.

- AK: Die manuelle Angebotsübernahme im Originalformat (`extension/shared.js`, `toDashboardOffers`) wird weiter
  angenommen und bewertet; die Rückwärtskompatibilität ist getestet.
- Testfälle:
  - `live.test.ts` › *Rückwärtskompatibilität: Extension-Nutzlast im Originalformat …*
  - `api.test.ts` › *Extension-Angebote werden bewertet …*
  - Extension-Suite: `extension/test/run-test.ps1` (headless Chrome, lokal)
- DoD: Tests grün. Die Erweiterung ist als optionaler manueller Zusatz dokumentiert, nicht als Ersatz für die
  automatische Überwachung.

---

## Offene Punkte (Backlog)

| ID | Titel | Labels | Priorität |
|---|---|---|---|
| B-1 | CardTrader-Feed mit eigenem Token live verifizieren (Felder, Linkformat, Limits, reale IDs) | `live-listings`, `api`, `blocked-by-provider` | P1 |
| B-2 | CardTrader-Versandkosten je Verkäufer (`/shipping_methods`) statt Schätzung | `profit`, `api` | P2 |
| B-3 | Extension-Tests (headless Chrome) in CI auf einem Windows-Runner | `regression` | P3 |
| B-4 | eBay-Adapter nur mit strenger Titelprüfung, wenn Produktionszugang vorliegt | `api`, `blocked-by-provider` | P3 |
| B-5 | Cardmarket-API, sobald Anträge wieder angenommen werden | `api`, `blocked-by-provider` | P2 |
