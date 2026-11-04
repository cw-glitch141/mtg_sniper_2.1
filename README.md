# MTG Deal Sniper 2.2 – Business Edition

Lokale Plattform für den Handel mit Magic-Einzelkarten auf Cardmarket – vom Deal bis zur Gewinnauswertung:

**Deal erkennen → Kauf entscheiden → Karte bestellen → Wareneingang → Einlagern → Anbieten → Bestellung bearbeiten → Versenden → Gewinn auswerten**

Sie arbeitet **ohne private Cardmarket-API**: mit den öffentlich verlinkten täglichen Cardmarket-Dateien,
der Scryfall-Zuordnung, den Angeboten, die du selbst auf Kartenseiten siehst (Browser-Erweiterung oder manueller Import),
und deinen eigenen Einkaufs-, Lager- und Verkaufsdaten. Ausgelegt auf zunächst 50–300 verkaufte Karten im Monat.

> Kein Versprechen auf Gewinn. Das System ist eine datenbasierte Entscheidungshilfe, deren Prognosen sich
> in Profit Analytics an echten Verkäufen überprüfen lassen. Prognosen und reale Ergebnisse sind überall getrennt gekennzeichnet.

## Live-Deal-Radar (2.2) – ehrlicher Status

| Frage | Antwort (Stand 04.11.2026) |
|---|---|
| **Welche Quelle ist aktiv?** | **Keine Live-Quelle.** Die App meldet wörtlich: *„Automatische Cardmarket-Angebotsüberwachung nicht verfügbar – keine Live-Datenquelle verbunden“*. Cardmarket nimmt keine API-Anträge an; der Price Guide enthält keine Einzelangebote. Implementiert ist ein Adapter für die **CardTrader-API** (anderer Marktplatz, eigenes Token). Er ist **nicht verifiziert**, weil kein Token vorliegt. |
| **Welche Karten werden überwacht?** | Sobald ein Feed bereit ist: eine dynamische Zielmenge (Standard bis 300 Varianten) aus Preisband, belegten Verkäufen (1-/7-Tages-Ø), Preisbewegung und Watchlist, ohne Ausreißer. Nur Varianten, die der Feed tatsächlich abdeckt, gelten als abgedeckt. Die Liste steht im Dashboard unter **Live-Radar**. **Keine Vollabdeckung des Cardmarket-Markts.** |
| **Wie aktuell sind die Daten?** | Price Guide: einmal täglich. Feed: Abfrage alle 10 Minuten (einstellbar). Die tatsächliche Verzögerung wird gemessen und angezeigt (ohne Quell-Zeitstempel als Obergrenze). Es gibt keine ungemessene „Echtzeit“-Behauptung. |
| **Was fehlt für den Vollbetrieb?** | Ein eigenes CardTrader-Konto und Token (`CARDTRADER_TOKEN` in `.env`), die selbst gelesenen und in den Einstellungen bestätigten CardTrader-API-Bedingungen und ein erster echter Lauf mit realen Angebots-IDs. Laut Recherche entstehen keine API-Kosten, bitte selbst prüfen. Für **Cardmarket**-Angebote fehlt eine Cardmarket-API-Zulassung, die derzeit nicht möglich ist. Details: [docs/datenquellen.md](docs/datenquellen.md). |

Die **autonome Sniper-Funktion ist erst fertig, wenn ein Listing-Feed nachweislich angeschlossen ist** (siehe US-04 in
[docs/user-stories.md](docs/user-stories.md)). Bis dahin stammen Kaufchancen nur aus Angeboten, die du mit der
Browser-Erweiterung oder per CSV erfasst. Die Erweiterung bleibt ein optionaler manueller Zusatz.

Was sich in 2.2 an der Darstellung geändert hat:

- **Kaufchancen** (früher „Trading Opportunities“) zeigt nur belegte Einzelangebote. „KAUFEN“ erscheint nur bei einem
  vollständigen (Verkäufer, Preis, Link, Zustand, Sprache), frischen und auch konservativ rentablen Angebot.
  Fehlende Angaben führen zu „PRÜFEN“.
- **Market Watch / Recherche** zeigt Price-Dip, Volatilität und Tiefstpreis nur noch als Referenzwerte und
  Trendunterschiede, plus einen ausdrücklich **hypothetischen Modellwert**. Dort gibt es weder Einkaufspreis noch Gewinn
  und keinen „Gekauft erfassen“-Button.
- Kennzeichnung überall: **LIVE-ANGEBOT**, **MARKTSIGNAL**, **VERALTET**, **SIMULATION**/**TEST** sowie **SYSTEM** für
  Betreiber-Meldungen.
- Ein Kauf eines Angebots muss bestätigt werden: „unmittelbar vor der Zahlung auf der Angebotsseite geprüft“.
  Eine alte Beobachtung belegt nicht, dass das Angebot noch verfügbar ist.
- Täglicher **Qualitätsbericht** (`scripts/daily-quality.ps1`) und **Betreiber-Warnungen** bei Ausfall oder veralteten Daten.

Test-Feed zum Ausprobieren (nur SIMULATION, nie extern versendet): `MTGDS_MOCK_FEED=1` in `.env`, danach im
**Live-Radar** zweimal „Jetzt abfragen“. Die erste Abfrage legt die Grundlinie an, die zweite erzeugt TEST-Ereignisse.
Nicht mit der echten Datenbank verwenden, wenn du keine Testangebote darin haben möchtest
(`MTGDS_DATA_DIR` auf einen anderen Ordner setzen).

## Update von 2.1 auf 2.2

- Laufenden Server beenden und `start.cmd` starten. `start.cmd` baut das Dashboard jetzt bei jedem Start neu.
- Migration 3 ist rein additiv: neue Spalten an `offers`, neue Tabellen für Feed-Läufe, Ereignisse, Zielmenge,
  Zuordnung und Qualitätsberichte. Vorher wird automatisch gesichert (`data/backups/mtgds-before-migration-3-….sqlite`).
  Getestet auf einer Kopie der echten Datenbank.
- API-Änderung: `POST /api/decisions` mit `decision: "accepted"` verlangt für Live-Angebote `confirmedAvailable: true`
  und lehnt Marktsignale ab.

## Update von 2.0 auf 2.1

- **Laufenden 2.0-Server beenden** (Fenster schließen) und `start.cmd` erneut starten – ein alter Server läuft sonst mit
  altem Code gegen die neue Datenbank weiter.
- Die Datenbank wird beim ersten Start automatisch migriert. **Vorher wird eine vollständige Sicherung angelegt**
  (`data/backups/mtgds-before-migration-2-….sqlite`). Markt-, Preis-, Watchlist- und Alarmdaten bleiben erhalten;
  Posten aus dem 2.0-Journal werden in Einkauf, Charge und (falls verkauft) Verkaufsauftrag überführt, die alte Tabelle
  bleibt als `inventory_v20_legacy` bestehen.
- Neu im Dashboard (Seitenleiste „Geschäft“ und „Auswertung“): Purchase Manager, Inventory, Sales Orders, Shipping Center,
  Profit Analytics, Capital & Risk. Erster Schritt: unter **Capital & Risk** die Einlage des Handelskapitals buchen.

---

## Schnellstart (Windows)

1. **Node.js 24 LTS** installieren (https://nodejs.org). Für diese Installation wurde Node 24.22.2 bereits
   als portable Version nach `%LOCALAPPDATA%\Programs\nodejs` gelegt und dem Benutzer-PATH hinzugefügt.
2. Im Projektordner **`start.cmd`** doppelklicken. Beim ersten Start werden die Abhängigkeiten installiert
   und das Dashboard gebaut; danach öffnet sich `http://localhost:8787`.
3. Beim ersten Start lädt der Server automatisch Produktkatalog, Price Guide und Scryfall-Zuordnung
   (ca. 20 s, ~130 MB Download). Alternativ: Dashboard → **Datenquellen** → „Jetzt aktualisieren“.

Manuell im Terminal:

```powershell
npm install          # einmalig
npm run build        # Dashboard bauen (nach Änderungen an web/)
npm start            # Server + Dashboard auf http://localhost:8787
npm run import       # Import + Analyse + Alarme ohne laufenden Server (z. B. per Aufgabenplanung)
npm test             # 77 automatisierte Server-Tests (Markt, Profit, Lager, Aufträge, Kapital, Migration, API)
npm run typecheck    # TypeScript-Prüfung (Server + Dashboard)
npm run token        # API-Token für die Browser-Erweiterung anzeigen
```

Entwicklung mit Hot-Reload: `npm run dev:server` und in einem zweiten Terminal `npm run dev:web` (Port 5173, leitet `/api` weiter).

**Automatischer Betrieb:** Solange der Server läuft, prüft er alle 2 Stunden per HEAD-Request, ob Cardmarket einen
neuen Price Guide veröffentlicht hat, und importiert nur dann. Wenn der Rechner nicht dauerhaft läuft, lege in der
Windows-Aufgabenplanung eine tägliche Aufgabe an (z. B. 06:00): Programm `npm.cmd`, Argumente `run import`,
Starten in: Projektordner. Jeder Tag ohne Import fehlt in der Historie – er wird nie nachträglich erfunden.

---

## Was das System kann – und was nicht

| Signalklasse | Bedeutung | Kann „KAUFEN“ werden? |
|---|---|---|
| **MARKTSIGNAL** | Erkenntnis aus aggregierten bzw. historischen Preisdaten (Price Guide, eigene Snapshots). Kein konkretes Angebot bekannt, daher kein Einkaufspreis und kein Gewinn – nur Referenzwerte und ein hypothetischer Modellwert (Market Watch). | Nein – höchstens **PRÜFEN** („Angebot suchen und prüfen“) |
| **LIVE-ANGEBOT** | Tatsächlich beobachtetes Einzelangebot mit Beobachtungszeitpunkt (Extension, manueller Import oder autorisierter Feed). | Ja, wenn alle Kaufregeln erfüllt sind, alle Pflichtangaben vorliegen, das Angebot frisch ist (Feed: 60 Min., sonst 48 h) und das konservative Szenario die Mindestwerte erreicht |
| **VERALTET** (Zusatz) | Angebot oder Price Guide älter als die Frische-Grenze. | Nein |
| **SYSTEM** | Betreiber-Meldung (Import- oder Feed-Ausfall, veraltete Daten). | – (kein Handelssignal) |
| **SIMULATION** | Testdaten ohne Kaufmöglichkeit. | Nie; wird nie an Telegram/Discord gesendet |

Die Klasse steht in Tabelle, Detailansicht, Alarmen und CSV-Export.

**Wichtige Grenzen**

- Der Cardmarket Price Guide ist **einmal täglich** erzeugt (nachts) und **aggregiert**: kein Einzelangebot,
  **nicht nach Zustand oder Sprache getrennt**. „Tiefstpreis“ kann ein Angebot in schlechtem Zustand oder anderer
  Sprache sein und muss nicht mehr existieren.
- Cardmarket liefert **keine Verkaufszahlen**. „Liquidität“ ist ein ausdrücklich gekennzeichneter **Proxy**
  (gibt es überhaupt 1-/7-/30-Tages-Durchschnitte, wie stark streuen sie).
- Die **eigene Historie beginnt am Tag des ersten Imports** (hier: 04.11.2026). 7-/30-Tage-Veränderungen,
  gleitende Durchschnitte und Volatilität erscheinen erst, wenn genug Tage vorliegen; bis dahin steht
  „Historie < 7 Tage“ bzw. „mindestens 14 Tage nötig“. Am ersten Tag nutzt der Price-Dip-Scanner die
  Cardmarket-Aggregate (1-Tages-Ø vs. 30-Tages-Ø) und kennzeichnet das.
- Ohne Live-Angebote gibt es keine Kaufempfehlungen, nur Marktsignale zum Prüfen.
- Ohne autorisierten Listing-Feed entstehen keine automatischen Angebote (siehe „Live-Deal-Radar“ oben).

---

## Datenquellen (geprüft am 04.11.2026)

| Quelle | Inhalt | Aktualisierung | Nutzung im System |
|---|---|---|---|
| `downloads.s3.cardmarket.com/.../price_guide_1.json` (26 MB) | `{version, createdAt, priceGuides[]}` mit `idProduct, idCategory, avg, low, trend, avg1, avg7, avg30` und `-foil`-Varianten; 130.363 Einträge, davon 125.205 Singles (`idCategory` 1) | täglich, Datei vom 04.11.2026 02:47 MEZ | `price_latest` (alle) + tägliche `price_snapshots` (Varianten ab 2 € sowie alles auf Watchlist/im Bestand/mit Angeboten) |
| `.../products_singles_1.json` (21 MB) | `idProduct, name, idExpansion, idMetacard, dateAdded`; 125.255 Produkte. **Kein Editionsname, keine Collector Number** | täglich | Produktstamm, stabile ID |
| Scryfall Bulk „Default Cards“ (`jsonl.gz`, 80 MB) | u. a. `cardmarket_id`, Set-Code, Set-Name, Collector Number, Seltenheit, Finishes, Bild | täglich, hier wöchentlich geladen | 101.738 Produkte eindeutig zugeordnet, 376 mehrdeutig (markiert), 12.772 nur Edition bekannt |

Zuordnung immer über **IDs** (Cardmarket `idProduct` ↔ Scryfall `cardmarket_id`), nie nur über Namen.
Die Rohdateien werden komprimiert unter `data/raw/` archiviert (Price Guide: letzte 14 Tage), damit jede Zahl nachprüfbar bleibt.

**Nutzungsbedingungen:** Die Cardmarket-Dateien sind öffentlich verlinkt und wurden ohne Login geladen.
Die Seiten mit Erläuterungen und Bedingungen (`cardmarket.com/.../Data/Price-Guide`, API-Doku) waren für den
automatischen Abruf nicht erreichbar (HTTP 403 bzw. 410) – **bitte die Bedingungen einmal selbst im eingeloggten
Browser lesen**, besonders falls du Daten weitergeben oder veröffentlichen willst. Das System lädt jede Datei höchstens
einmal pro Tag (Änderungsprüfung per HEAD, `If-None-Match`), mit eigenem User-Agent, und nutzt die Daten nur lokal.
Scryfall: Bulk-Dateien statt Einzelabfragen, Zwischenspeicherung > 24 h, eigener User-Agent – wie von Scryfall verlangt.

**Bewusst nicht enthalten:** kein Crawling von Cardmarket-Seiten, kein Umgehen von Captchas/Logins/Sperren, keine
fremden API-Zugänge, kein automatischer Kauf und keine Warenkorbbefüllung.

---

## Module

### Market Intelligence (Import & Historie)
`server/src/services/importer.ts` – Katalog, Price Guide, Scryfall; jeder Lauf in `import_runs` mit Status, Zeilen,
Datenstand und Fehlermeldung. Fehlende Werte bleiben `NULL` (nie 0). Gleicher Datenstand wird nicht doppelt importiert.
Kennzahlen (`server/src/analytics/stats.ts`): Veränderung 1/7/30 Tage, gleitende Durchschnitte, Tagesvolatilität
(Log-Renditen), Spanne/Rückgang vom Hoch, z-Score, Preisumkehr – jeweils mit Anzahl der Datenpunkte bzw. „unzureichend“.

### Deal Detection (Strategien)
| # | Strategie | Datei | Kurzbeschreibung |
|---|---|---|---|
| 1 | Unterbewertete Einzelangebote | `services/offers.ts` | Beobachtetes Angebot vs. Referenz **derselben Variante** (Produkt-ID + Finish), Zustand/Sprache als Faktoren, Porto, Angebotsalter |
| 2 | Price-Dip | `analytics/strategies.ts` | 1-Tages-Ø ≥ 15 % unter 30-Tages-Ø, 7-Tage-Rückgang der eigenen Historie oder z ≤ −2. Ein Rückgang nur im 1-Tages-Ø (evtl. ein Einzelverkauf) gilt als unbestätigt (−10 Confidence) |
| 3 | Volatilität | `analytics/strategies.ts` | erst ab 14 Tagen Historie; zusätzlich Preis im unteren Viertel der Spanne **und** Median ≥ Mindest-Rabatt darüber |
| 4 | Spread | `analytics/strategies.ts` + Profit-Engine | Einkauf vs. konservativer Wiederverkauf; Marktsignal-Variante auf Basis des gemeldeten Tiefstpreises (Confidence max. 45) |
| 5 | Verkäufer-Bündelung | `services/bundles.ts` | aus v1.1 übernommen: Watchlist-Bündel mit Ersparnis vs. Einzelkauf; neu: profitable Live-Angebote je Verkäufer mit geteiltem Porto; veraltete Beobachtungen markiert |
| 6 | Opportunity Ranking | `services/analysis.ts` | globale Rangliste nach Score, Confidence, Ertrag; letzte 7 Läufe für Ranking-Änderungen |

**Ausreißerschutz:** Liegen Trend und Durchschnitte einer Variante um mehr als Faktor 3 auseinander (dünner Markt,
Einzelverkäufe zu Extrempreisen), entsteht kein Marktsignal (am 04.11.2026: 643 Varianten). Einstellbar.

### Profit-Engine (`server/src/analytics/profit.ts`)
Für jede Möglichkeit drei Szenarien und eine vollständige Kostenaufstellung (im Dashboard „Rechenweg anzeigen“):

```
Wiederverkauf  konservativ = min(Trend, 7-T-Ø, 30-T-Ø) × (1 − 12 %) × Zustandsfaktor × Sprachfaktor
               basis       = Median(…)                 × (1 − 5 %)  × …
               optimistisch= max(…)                                 × …      (nicht garantiert)
Gewinn = Verkauf − USt (je Steuermodus) − Einkauf (Preis + Porto + Sonstiges)
         − Provision (5 %) − Zahlungsgebühr − Verpackung (0,35 €) − ungedecktes Porto (0,20 €)
         − Retouren-/Verlustrisiko (2 % des Verkaufs) − Arbeitszeit (5 min × 12 €/h)
ROI = Gewinn / gebundenes Kapital, Marge = Gewinn / Verkaufspreis
```
Dazu Break-even-Verkaufspreis und maximal zulässiger Einkaufspreis (Mindestgewinn **und** Ziel-ROI).
Steuermodi: **Kleinunternehmer** (Standard; keine USt, kein Vorsteuerabzug), **Regelbesteuerung** (USt herausrechnen,
Vorsteuer auf Gebühren/Verpackung, optional auf den Einkauf), **Differenzbesteuerung §25a** (USt nur auf die Marge),
**Privatverkauf**. Gewinne sind vor Ertragsteuern. Rechenhilfe, keine Steuerberatung.

Die Werte sind per Hand nachgerechnet und in `server/test/profit.test.ts` festgeschrieben.

### Buy-Rules (Einstellungen → Kaufregeln)
Startwerte: Preisband 15–500 €, Mindestgewinn 5 €, Small-Profit-Modus 3 € (bei ≤ 40 € Kapital und ≥ 20 % ROI),
Ziel-ROI 15 %, Mindest-Rabatt 12 %, max. 250 € je Karte, max. 2.000 € Gesamtbestand, Mindest-Confidence 50,
Angebote max. 48 h alt, Sprachen en/de, Zustand mindestens EX. Optional: „kein Verlust im konservativen Szenario“.
Jede Regel wird mit ✓/✗ und Begründung angezeigt. **Startwerte, keine nachgewiesen optimalen Werte.**

> Beobachtung aus dem Simulationstest (200 Angebote zu 60–105 % des Trends): Mit den Standardkosten braucht ein
> Angebot bei Karten um 30–80 € meist **25–30 % Abstand zur Referenz**, um 5 € und 15 % ROI zu erreichen.
> Der Mindest-Rabatt von 12 % ist daher nie die bindende Regel. Das Journal zeigt mit der Zeit, welche Werte sich bewähren.

### Smart Deal Score & Confidence (`server/src/analytics/score.ts`)
Score 0–100, Gewichte einstellbar (Start: Nettoertrag/ROI 35, Liquidität-Proxy 25, Preisabweichung 15,
Stabilität 10, Datenqualität 10, Risiko 5). Der Ertragsteil wertet Basis- und konservatives Szenario je zur Hälfte.
Die **Confidence** ist getrennt (Signalart, Übereinstimmung der Referenzen, Historienlänge, Alter von Price Guide und
Angebot, Zuordnung, Ausreißerverdacht). Liegt sie unter der Mindest-Confidence, wird der Score auf höchstens 45
herunterskaliert, und es gibt weder Empfehlung noch Alarm. Jede Komponente hat eine kurze Begründung.

### Business-Alerts (`server/src/services/alerts.ts`)
Drei Prioritäten (zusätzlich zur Signalklasse MARKTSIGNAL / LIVE-ANGEBOT / SIMULATION):

| Priorität | Bedingung (Startwerte einstellbar) |
|---|---|
| **HIGH PRIORITY** | Live-Angebot ≤ 12 h alt, alle Kaufregeln **inkl. Bestands- und Kapitallimits** erfüllt, konservativer Gewinn ≥ 3 € und konservativer ROI ≥ 10 %, Confidence ≥ 65 |
| **MEDIUM PRIORITY** | Live-Angebot mit erfüllten Regeln, aber nicht HIGH – oder Marktsignal „PRÜFEN“ (Rentabilität/Datenlage noch prüfen) |
| **MARKET WATCH** | Preisentwicklung oder Auffälligkeit ohne kaufbares Angebot (Bewegungen, große Rückgänge, Marktsignale außerhalb der Regeln) |

Arten: Live-Angebote, Preisauffälligkeiten (Top-N je Strategie), Watchlist-Zielpreise, große Tagesrückgänge,
tägliche Marktbewegungen, neu in den Top-N. Jeder Alarm enthält Karte, Edition, Zustand, Einkauf, geschätzten
Verkauf, Gewinn, ROI, Price-Guide-Stand, Beobachtungszeit, Quelle, Confidence und Link.
**Ein Deal = ein Schlüssel**: Trifft dasselbe Angebot als Watchlist-Treffer, Kaufempfehlung und Ranking-Änderung zu,
wird es nur einmal gemeldet (+ 24 h Cooldown); erst ein geänderter Preis ist ein neuer Deal.
Kanäle: Dashboard, Desktop (solange das Dashboard offen ist), Telegram, Discord – extern standardmäßig ab MEDIUM
(Einstellung „Telegram/Discord ab Priorität“). Simulationen gehen nie nach außen. E-Mail ist **nicht** umgesetzt.

Telegram/Discord einrichten: `.env.example` nach `.env` kopieren, Zugangsdaten eintragen, Server neu starten,
dann Settings → Alarme → Kanal aktivieren und unter **Alarme → Testalarm senden** prüfen.

### Dashboard (`web/`)
Seitenleiste in vier Bereichen:
- **Markt:** Übersicht · **Trading Opportunities** (Rangliste mit Priorität, Bestand der Karte, Filter, gespeicherte
  Ansichten, CSV, Detailansicht) · **Market Watch** (Bewegungen 1/7/30 Tage, Marktsignale, MARKET-WATCH-Alarme) ·
  Angebote & Bündel · Watchlist (Mindestzustand/Sprachen je Eintrag) · Alarme
- **Geschäft:** Purchase Manager · Inventory · Sales Orders · Shipping Center
- **Auswertung:** Profit Analytics · Capital & Risk
- **System:** Profit-Rechner · Datenquellen · Settings

Direktlinks: `#/scanner?product=<id>` (Detailansicht), `#/orders?order=<id>`.

---

## Business Edition (2.1)

### Kapital & Portfolio (`server/src/services/portfolio.ts`, Seite „Capital & Risk“)
Die **Kasse** wird ausschließlich aus Belegen abgeleitet: Kapitalbuch (Einlagen, Entnahmen, laufende Kosten,
Steuerzahlungen, Korrekturen) − bezahlte Einkäufe + Erstattungen + Zahlungseingänge aus Verkäufen (abzüglich Gebühren)
− Porto/Verpackung versendeter Aufträge. Daraus:

| Kennzahl | Bedeutung |
|---|---|
| Handelskapital gesamt | Kasse + Lager zum Einstand + bezahlte, noch nicht gelieferte Ware + Forderungen |
| Verfügbares Kapital | Kasse − für geplante/bestellte Einkäufe reserviertes Kapital − Mindestreserve |
| Reserviert für Einkäufe | geplante und bestellte, noch unbezahlte Einkäufe |
| Eingesetzt im Lager / unterwegs | Einstand des Geschäftsbestands bzw. bezahlter, offener Lieferungen |
| Unverkaufte Ware | freie Exemplare mit Einstand (reservierte separat) |
| Erwartete Erlöse | **Prognose**: Angebotspreis bzw. Basis-Marktwert freier Exemplare + Auftragswert reservierter |
| Realisierte Erlöse / DB | aus versendeten Aufträgen |
| Offene Verpflichtungen | reservierte Einkäufe + geschätzte USt-Zahllast (abzgl. gebuchter Steuerzahlungen) |

**Limits** (Settings → Kapital- und Risikolimits) fließen als Kaufregeln in **jede** Empfehlung ein:
max. Kaufbetrag je Karte, **max. identische Exemplare (Bestand + bereits bestellt)**, max. Investition je Edition,
max. Gesamtbestand, max. Anteil langsam verkäuflicher Ware (Charge ≥ 60 Tage unverkauft), Mindestreserve.
Wer schon 4 Exemplare hat (Standardgrenze), bekommt für diese Karte keine Kaufempfehlung mehr – die Begründung nennt den Bestand.
Täglich wird ein Bestandswert-Schnappschuss (Einstand vs. geschätzter Marktwert) gespeichert.

### Einkauf (`server/src/services/purchases.ts`, „Purchase Manager“)
Status **Geplant** (Kapital reserviert) → **Bestellt** → **Bezahlt** → **Teilgeliefert** → **Eingelagert**, dazu Problem,
Storniert, Zurückgegeben (mit Erstattung). Kauf, Zahlung und Lieferung sind getrennte Schritte. Porto und sonstige
Einkaufskosten werden **centgenau nach Warenwert** auf die Positionen verteilt und gehen anteilig in den Einstand der
Chargen ein; ändert sich das Porto nachträglich, werden eingelagerte Chargen neu belastet. Steuerbehandlung je Einkauf:
ohne USt (Privatverkäufer), Rechnung mit USt, Händler mit Differenzbesteuerung. „Gekauft erfassen“ in der
Detailansicht einer Empfehlung legt automatisch einen Einkauf an und verknüpft ihn mit der Entscheidung.

### Lager (`server/src/services/stock.ts`, „Inventory“)
Jeder Wareneingang ist eine **Charge** (Bestands-ID `L000123`) mit Cardmarket-Produkt-ID, Druck (Set, Nummer),
Sprache, Zustand, Finish, Menge, Einstandspreis, zugeordneten Nebenkosten, Einkaufsdatum, Lieferstatus, **Lagerplatz**
(Schema A01, A02, B01 … als regulärer Ausdruck einstellbar, mehrere Lager vorbereitet), Verkaufsstatus, Plattform,
Angebotspreis und realisiertem Erlös. Mehrere Chargen derselben Karte zu verschiedenen Einstandspreisen werden
getrennt geführt und **FIFO** verkauft.

- **Keine Doppelverkäufe:** Beim Anlegen eines Auftrags werden Exemplare reserviert; verfügbar = Bestand − reserviert.
  Datenbank-Constraints erzwingen das zusätzlich. Jede Mengenänderung steht im Bewegungsprotokoll.
- **Privatbestand strikt getrennt:** Privatkarten (optional mit Deck-Namen) sind nicht verkäuflich, nicht reservierbar
  und in keiner Geschäftszahl enthalten. Wechsel Geschäft ↔ Privat nur ausdrücklich über „Teilmenge umlagern“.
- Inventurkorrekturen mit Pflichtgrund, Umlagern von Teilmengen, Anfangsbestand erfassen.
- **QR-Etiketten** (62 × 29 mm, Brother-QL-kompatibel oder A4) mit Bestands-ID; jedes Such-/Scan-Feld akzeptiert die ID.
- CSV-Export des Bestands.

### Repricing (`server/src/services/repricing.ts`, Inventory → Repricing)
Für jede freie Charge: **Verlustgrenze** (kleinster Preis mit Deckungsbeitrag ≥ 0 aus tatsächlichem Einstand, Gebühren
und der Steuerbehandlung dieser Charge), **Zielpreis** (Ziel-DB 2 € und Ziel-Marge 10 %), aktueller Marktwert und
Marktwert ggü. Einstand. Befunde: noch nicht angeboten, zu teuer (> Markt + 10 %), zu günstig (< Markt − 15 %),
lange unverkauft (≥ 45 Tage → Senkung um 5 %), an der Untergrenze, unter Verlustgrenze.
**Kein Vorschlag liegt je unter max(Verlustgrenze, absoluter Mindestpreis, Mindestgrenze der Charge)**; ein manueller
Preis darunter braucht eine ausdrückliche Bestätigung. Preise werden nur im eigenen Lager gesetzt – ohne autorisierte
Marktplatz-Schnittstelle nichts automatisch auf Cardmarket (CSV-Arbeitsliste zum Übertragen).

### Verkauf & Versand (`server/src/services/sales.ts`, „Sales Orders“, „Shipping Center“)
Status **Neu → Geprüft (Zahlung bestätigt) → Pickliste → Gepackt → Versendet → Abgeschlossen**, dazu Storniert
(gibt Reservierungen frei), Retourniert, Problem. Zahlungsstatus (offen/eingegangen/erstattet) ist separat.
- Aufträge manuell (Karte aus verfügbarem Bestand wählen oder scannen) oder per **CSV-Import**:
  `order_id;platform;buyer;country;ordered_at;paid;shipping_charged;idProduct;name;set;condition;language;foil;qty;price`
  – mehrere Zeilen je Auftrag, jeder Auftrag ganz oder gar nicht, **Dubletten** (Plattform + Auftragsnummer) und
  fehlerhafte Zeilen werden mit Grund gemeldet.
- **Sammel-Pickliste** über mehrere Aufträge, sortiert nach Lager und Lagerplatz, druckbar.
- **Pack-Checkliste** mit Scan-Abgleich (falsche Karte wird gemeldet), Porto/Verpackung/Gebühr sichtbar vorbelegt
  (keine stillschweigenden Werte – Versand nur mit angegebenen Kosten), Sendungsnummer, Adressetikett (Adresse bleibt lokal).
- **Fehlende Karte** melden → Exemplar wird ausgebucht, Auftrag auf PROBLEM; dann aus anderer Charge nachreservieren
  oder Position kürzen (Erstattungshinweis).
- **Rücksendungen** teilweise oder vollständig, mit Wiedereinlagerung (Wareneinsatz entfällt) oder Ausbuchung (Verlust bleibt).
- Überfällige Aufträge sind markiert, Priorität je Auftrag, Archivierung erledigter Aufträge nach 30 Tagen.
- Eine direkte Cardmarket-Bestellsynchronisierung ist **nicht** eingebaut (nur über eine offiziell erlaubte Schnittstelle).

### Trading Journal & Profit Analytics (`server/src/analytics/accounting.ts`, `server/src/services/businessAnalytics.ts`)
Ergebnis je Auftrag: Umsatz (Artikel + Käuferporto − Erstattungen) − Umsatzsteuer = Nettoerlös − Wareneinsatz
(Einstand inkl. Nebenkosten, ggf. abzüglich Vorsteuer) − Gebühren − Porto − Verpackung − Sonstiges = **Deckungsbeitrag**.
Porto und Verpackung zählen **einmal je Auftrag**, auch bei vielen Karten (für Auswertungen anteilig verteilt).
Kalkulatorische Arbeitszeit (6 min je Auftrag + 1,5 min je Karte + 4 min je Einkauf) wird getrennt ausgewiesen.

Steuer **je Exemplar** statt pauschal: Kleinunternehmer/Privat ohne USt; Regelbesteuerung mit Vorsteuer nur für
Einkäufe mit Rechnung; Differenzbesteuerung je Charge (§25a für Einkäufe ohne Vorsteuer, regulär für Einkäufe mit
Rechnung). Getrennt ausgewiesen: **Umsatz, Deckungsbeitrag, Gewinn vor Steuern** (DB − laufende Kosten),
**USt-Zahllast** und **Geldfluss** (Ein-/Auszahlungen nach Zahlungsdatum). Einkommensteuer wird nicht berechnet.

Kennzahlen (Profit Analytics): Monatsumsatz und -DB (Diagramm + Tabelle), Verkaufsvolumen, Ø Gewinn je Karte und je
Auftrag, Gewinn je Arbeitsstunde, Ø Lagerdauer, Lagerumschlag, Kapitalbindung, Bestand, offene Aufträge,
Retourenquote, Erfolgsquote der Empfehlungen. Prognosen (erwartete Erlöse) sind gestrichelt und als „Prognose“ markiert.

### Strategievalidierung (Profit Analytics → Strategievalidierung)
Jede Empfehlung (KAUFEN/PRÜFEN) wird einmalig protokolliert, jede Entscheidung (gekauft/abgelehnt) mit damaliger
Bewertung. Ausgewertet werden **nur reale Daten**: Kaufquote, verkaufte Karten, Abverkaufsdauer, realisierter DB je
Karte, Verluste, noch gebundenes Kapital – gruppiert nach Strategie, Priorität, Preisbereich, Seltenheit, Finish,
Score- und Confidence-Band, plus Filter-Test („Was hätte ein Mindest-Score/-Confidence/-Rabatt gebracht?“).
Gruppen mit weniger als 10 Entscheidungen sind als „zu wenige Daten“ markiert. Keine erfundenen Quoten oder
Verkaufswahrscheinlichkeiten. Das Entscheidungsprotokoll zeigt zusätzlich „Trend heute ggü. Einkauf“.

### Konkurrenz-Benchmark
Siehe [`docs/benchmark.md`](docs/benchmark.md): Vergleichsmatrix TCGSniper, CardTracker, TCG PowerTools und welche
Ideen übernommen wurden (Repricing-Vorschläge, CSV-Workflows, Scan-Bedienung, Watchlist-Filter je Eintrag) – und
welche bewusst nicht (Crawling, Warenkorbbefüllung, automatische Veröffentlichung ohne Schnittstelle).

---

## Browser-Erweiterung (Ordner `extension/`, Version 2.0.0)

Alle Funktionen aus 1.1.0 bleiben erhalten (Deals markieren, Porto, Watchlist, Deckliste, Preisverlauf, Bündeln).
Neu:
- **Produktidentifikation über die Cardmarket-ID** (`input[name="idProduct"]`, aus der gespeicherten Seite verifiziert)
  und Artikel-ID je Angebotszeile – dadurch exakte Druckvariante statt Namensvergleich.
- **„An Dashboard senden“** (Popup → Dashboard): standardmäßig **aus**. Wenn aktiviert, werden die bereits geladenen
  Angebote der Seite, die du selbst öffnest, an `127.0.0.1` gesendet. Kein Nachladen, keine anderen Server.
  Das Token bleibt lokal (nicht in der Chrome-Synchronisierung).
- **Netto-Gewinn neben dem Preis** (nach allen Kosten, mit Empfehlung, Score und Confidence im Tooltip).
- Preisänderungen eines Angebots werden erkannt (vorheriger Preis), Beobachtungszeit wird mitgesendet.
- **Watchlist übertragen**: übernimmt die Watchlist idempotent ins Dashboard; die Daten in der Erweiterung bleiben unverändert.

Installation: `chrome://extensions` → Entwicklermodus → „Entpackte Erweiterung laden“ → Ordner **`extension`**.
Der Ordner hat sich geändert (vorher Projektordner). Chrome vergibt für den neuen Pfad eine neue Extension-ID mit
**leerem Speicher**; den alten Eintrag (zeigt jetzt einen Fehler) entfernen. In deinem Chrome-Profil waren keine
gespeicherten Watchlist-Einträge der alten Version zu finden. Falls doch welche fehlen: Deckliste erneut einfügen.
Dann im Dashboard unter Einstellungen das Token kopieren und im Popup → Dashboard einfügen, „Verbindung testen“.

Tests der Erweiterung (headless Chrome, ohne Netzwerk): `powershell -ExecutionPolicy Bypass -File extension\test\run-test.ps1` (47 Prüfungen).

---

## Architektur

```
server/            Node.js 24 + TypeScript (direkt ausgeführt, ohne Build), keine Laufzeit-Abhängigkeiten
  src/config.ts      Pfade, .env, Quell-URLs
  src/db/            SQLite (node:sqlite), versionierte Migrationen inkl. Datenmigration 2.0 → 2.1 und Sicherung davor
  src/domain/        Typen, Einstellungen + Validierung, Porto
  src/providers/     austauschbare Datenanbieter: Cardmarket-S3, Scryfall, HTTP; Schnittstelle OfferProvider
  src/analytics/     reine Rechenlogik: Profit, Buchhaltung je Auftrag, Wiederverkauf, Statistik, Regeln, Score, Strategien
  src/services/      Import, Analyse/Ranking, Angebote, Bündel, Alarme, Watchlist, Zeitplan, Simulation,
                     Einkauf, Lager, Verkauf/Versand, Kapital/Portfolio, Repricing, Analytics, Entscheidungen
  src/api/           HTTP-Router (Sicherheit), REST-Routen Markt (routes.ts) und Business (businessRoutes.ts)
  test/              node:test – Unit-, Pipeline-, Business- und API-Tests
web/               React 18 + TypeScript + Vite (nutzt die Server-Typen direkt); QR-Codes via qrcode-generator
extension/         Chrome-Erweiterung (MV3, reines JavaScript)
docs/              Konkurrenz-Benchmark
data/              SQLite-Datenbank, Sicherungen, Rohdaten-Archiv, Logs (wird erzeugt, nicht ins Repository)
backup/            Sicherung von Version 1.1.0 (Zip + altes README)
```

**Geschäftsdaten (2.1):** `purchase_orders` → `purchase_lines` → `stock_lots` (Charge, Eigentum Geschäft/Privat,
Lagerplatz `locations` mit Lager-Kennung) → `sales_allocations` ← `sales_order_lines` ← `sales_orders`; jede
Mengenänderung in `stock_movements`; Kapital in `capital_ledger`; Empfehlungen in `recommendation_log`; Bestandswert
in `portfolio_snapshots`. Alle Belegtabellen tragen eine Spalte `actor` (heute „owner“) als Grundlage für Mitarbeiter;
Plattform-Felder an Einkauf, Angebot und Auftrag sind für weitere Marktplätze vorbereitet; Chargen und Positionen
tragen `game_id` für Pokémon/Yu-Gi-Oh!.

**Datenmodell** (spielübergreifend): `games` → `expansions` → `products` (Anbieter + externe ID, Typ single/sealed) →
Variante = Produkt + Finish (+ Zustand/Sprache auf Angebotsebene) → Preisserien `price_latest`/`price_snapshots` je
Quelle. Pokémon/Yu-Gi-Oh!/Sealed: neuer Catalog-/PriceProvider mit eigener `gameId` (Cardmarket bietet weitere
`price_guide_<n>.json`-Dateien), keine Schemaänderung nötig. PostgreSQL: `server/src/db/database.ts` kapselt den Zugriff.

**Live-Angebotsfeed später anschließen:** `OfferProvider` in `server/src/providers/types.ts` implementieren und in
`createContext(..., { offers: [...] })` eintragen; die Angebote laufen durch `ingestOffers()` und erscheinen
automatisch als LIVE-ANGEBOT in Bewertung, Ranking, Alarmen und Dashboard. Nur mit gültiger Zulassung.

**Sicherheit:** Server nur auf `127.0.0.1`; Host-Header-Prüfung (DNS-Rebinding); schreibende Anfragen nur vom eigenen
Dashboard (`Sec-Fetch-Site: same-origin`) oder mit Token (`X-MTGDS-Token`); CORS nur für `chrome-extension://`;
Zugangsdaten nur in `.env`; Eingaben werden validiert, keine stillschweigenden Ersatzwerte.
Fällt eine Quelle aus, bleibt die App mit dem letzten Datenstand bedienbar und zeigt den Ausfall an.

### REST-API (Auszug)
`GET /api/status` · `POST /api/import {source: all|catalog|prices|scryfall, force}` · `POST /api/analyze` ·
`GET /api/opportunities?…` (+ `.csv`) · `GET /api/products/:id` · `GET /api/movers?window=1|7|30&dir=down|up` ·
`POST /api/calc` · `POST /api/offers {source: extension|manual, offers[]}` · `POST /api/offers/csv` ·
`POST|DELETE /api/simulation` · `GET /api/bundles?mode=watchlist|deals` · `/api/watchlist` · `/api/alerts?priority=` ·
`/api/decisions` · `/api/views` · `GET|PUT /api/settings`.

Business: `GET /api/portfolio` (+ `/history`) · `/api/ledger` · `/api/purchases` (+ `/:id/status`, `/lines/:id/receive`) ·
`/api/lots` (+ `.csv`, `/:id/adjust`, `/:id/split`) · `/api/locations` · `GET /api/repricing` (+ `.csv`, `POST /apply`) ·
`/api/orders` (+ `/import`, `/:id/status`, `/:id/return`, `/:id/resolve`, `/lines/:id/missing`, `/lines/:id/resolve-missing`,
`/archive`, `.csv`) · `POST /api/picklist` · `GET /api/analytics/profit` · `GET /api/analytics/validation`.

---

## Bekannte Einschränkungen / nächste Schritte

- Historien-Kennzahlen und Volatilitäts-Scanner werden erst mit täglichen Importen aussagekräftig (≥ 7 bzw. 14 Tage).
- Zustand/Sprache: Cardmarket-Referenzen sind nicht danach getrennt; die Faktoren (z. B. EX 0,9, Deutsch 0,95) sind Annahmen.
- Porto-Werte sind Richtwerte aus 1.1 – bitte eigene Erfahrungswerte eintragen.
- Der Scheduler läuft nur, solange der Server läuft (siehe Aufgabenplanung oben).
- E-Mail-Benachrichtigung, Pokémon/Yu-Gi-Oh!/Sealed-Import und PostgreSQL sind vorbereitet, aber nicht umgesetzt.
- Ein Benutzer, keine Rollen/Anmeldung: Der Server ist nur lokal erreichbar. Für Mitarbeiter wären Anmeldung, Rollen
  (z. B. Einkauf, Lager, Versand, Auswertung) und das Befüllen der vorhandenen `actor`-Spalten nötig.
- Steuer: vereinfachte Rechenhilfe (u. a. Käuferporto folgt der Behandlung der Ware, Briefporto ohne USt). Keine
  Steuerberatung; Einkommen-/Gewerbesteuer werden nicht berechnet.
- Retouren an den Einkaufsverkäufer sind nur möglich, solange aus dem Einkauf noch nichts verkauft oder reserviert ist.
- Mengenzuordnung beim Verkauf ist FIFO; eine bestimmte Charge kann bei manuellen Aufträgen gewählt werden.
- Die Erlösprognose nutzt den Angebotspreis oder den Basis-Marktwert; Karten ohne beides werden ausgewiesen, nicht geschätzt.

## Offene Schnittstellen

| Schnittstelle | Zustand | Anschlusspunkt |
|---|---|---|
| Cardmarket-Live-Angebote (offizielle API) | nicht verbunden (Cardmarket nimmt keine API-Anträge an) | `ListingProvider` in `server/src/providers/listings.ts` |
| CardTrader-Live-Angebote (offizielle API, eigenes Token) | Adapter implementiert, **nicht verifiziert** | `server/src/providers/cardtrader.ts`, Radar in `server/src/services/liveRadar.ts` |
| Cardmarket-Bestellungen importieren | manuell / Standard-CSV | `createOrder()` in `server/src/services/sales.ts` – ein zugelassener Provider kann Aufträge direkt anlegen (Dubletten-Schutz greift) |
| Cardmarket-Bestand / Preise setzen | Vorschläge + CSV-Arbeitsliste | `applyPrice()` in `server/src/services/repricing.ts`, Lagerdaten in `stock_lots` |
| Weitere Marktplätze (eBay, TCGplayer …) | Plattform-Felder vorhanden | `platform` an `purchase_orders`, `stock_lots.list_platform`, `sales_orders` |
| Versandetiketten (DHL/Post) | Adressetikett zum Drucken | Versanddaten an `sales_orders` (Adresse, Versandart, Sendungsnummer) |
| E-Mail-Alarme | nicht umgesetzt | `Sender` in `server/src/services/alerts.ts` |
- Selektoren der Erweiterung stammen aus einer gespeicherten Seite vom 04.11.2026 (`extension/sample.html`);
  ändert Cardmarket das Layout, siehe Abschnitt in `backup/README-v1.1.0.md` („Wenn Cardmarket das Layout ändert“) –
  alle Selektoren stehen in `extension/parser.js` → `SELECTORS`.
