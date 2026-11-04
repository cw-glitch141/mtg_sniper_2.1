# MTG Deal Sniper

Chrome-Extension (Manifest V3, reines JavaScript) für **cardmarket.com**. Auf Magic-Kartenseiten
(`https://www.cardmarket.com/*/Magic/Products/Singles/*`) wertet sie die angezeigten Angebote aus,
hebt Angebote unter Marktwert hervor (Porto eingerechnet), führt eine Watchlist mit Zielpreisen
und schlägt Verkäufer vor, bei denen du mehrere gesuchte Karten zusammen kaufen kannst.

Die Extension liest **nur das DOM der Seiten, die du selbst öffnest**. Sie stellt keine eigenen
Requests an Cardmarket, lädt nichts nach, crawlt nicht und legt nichts in den Warenkorb.

## Installation

1. Chrome öffnen und `chrome://extensions` aufrufen.
2. Oben rechts den **Entwicklermodus** einschalten.
3. **„Entpackte Erweiterung laden“** klicken und den Ordner `mtg-deal-sniper` auswählen
   (den Ordner, in dem `manifest.json` liegt).
4. Optional: Über das Puzzle-Symbol in der Symbolleiste „MTG Deal Sniper“ anheften.
5. Eine Kartenseite öffnen, z. B. `https://www.cardmarket.com/de/Magic/Products/Singles/Mirrodin/Chrome-Mox`.

Nach Änderungen am Code auf `chrome://extensions` beim Eintrag auf ⟳ (Neu laden) klicken
und die Cardmarket-Seite neu laden.

## Typischer Ablauf

1. **Deckliste einfügen:** Popup → Watchlist → „Deckliste einfügen“, z. B. aus Moxfield/Arena/MTGO kopiert.
2. **Karten durchklicken:** Der Kartenname im Popup führt zur Cardmarket-Suche bzw. zum zuletzt
   besuchten Druck. Auf jeder Kartenseite siehst du sofort Deals, Porto und Watchlist-Treffer.
3. **Bündeln:** Popup → Bündeln zeigt, welche Verkäufer mehrere deiner offenen Karten haben und
   ob sich das gegenüber dem Einzelkauf lohnt.
4. **Abhaken:** Gekaufte Karten im Popup oder auf der Kartenseite („✓ Gekauft“) markieren.

## Funktionen

| Funktion | Beschreibung |
|---|---|
| Rabatt | `(Referenzpreis − (Angebotspreis + Porto)) / Referenzpreis × 100` |
| Hervorhebung | Angebote mit Rabatt ≥ Schwellenwert werden grün markiert und bekommen ein Badge wie „-23 %“. Der Tooltip zeigt Preis + Porto. |
| Zusammenfassung | Box unter dem Kartentitel: Deals, bestes Angebot, Vergleichsbasis, Porto, letzter Besuch |
| Porto | Inland/Ausland, jeweils Brief oder versichert. Ab einem Warenwert (Standard 25 €) gilt der versicherte Versand. Alles im Popup einstellbar. |
| Vergleichsbasis | Trendpreis, niedrigster Wert aus Trend/30/7/1-Tages-Ø, oder bestes Angebot beim letzten Besuch |
| Verkäufer-Filter | Mindestanzahl Verkäufe, Verkäufertyp (alle / Powerseller+gewerblich / nur gewerblich) |
| Watchlist | Pro **Kartenname** (gilt für alle Drucke) mit Anzahl, optionalem Zielpreis (inkl. Porto) und „gekauft“-Haken. Treffer ≤ Zielpreis werden auf der Kartenseite gelb gemeldet und gold umrandet. |
| Deckliste | Erkennt `4 Lightning Bolt`, `4x …`, Arena `(M10) 146`, MTGO `SB:`, `*F*`, `[SET]`, Überschriften und kommagetrennte Listen. Doppelte Karten werden addiert. Beim erneuten Einfügen wird die Anzahl nicht verdoppelt. |
| Preisverlauf | Pro Besuch wird das beste passende Angebot gespeichert. Das Popup zeigt „zuletzt 108,00 € ↓ vorher 115,00 €“. |
| Bündeln | Verkäufer mit mehreren offenen Watchlist-Karten, Summe + Porto, Ersparnis gegenüber Einzelkauf (oder „lohnt nicht“) |

**Hinweise zur Bewertung**

- Nur Angebote, die zu deinen Filtern passen (Zustand, Sprache, Foil, Verkäufer), zählen als Deal,
  Watchlist-Treffer oder Bündel-Angebot.
- Foil ist standardmäßig ausgeschlossen, weil Cardmarkets Trendpreis für die Nicht-Foil-Version gilt.
- Ausgewertet werden nur die Angebote, die gerade auf der Seite stehen. Cardmarkets eigene Filter in
  der URL (z. B. `?sellerCountry=7&minCondition=3`) bestimmen also mit, was die Extension sieht.
- Die Porto-Standardwerte sind Schätzungen. Trag deine echten Erfahrungswerte ein.
- Die Bündelung ist eine Orientierung, keine optimale Gesamtlösung. Sie nutzt die Angebote der
  letzten 7 Tage, und Bestände können sich inzwischen geändert haben.
- Lädt Cardmarket weitere Angebote nach, erkennt ein MutationObserver die neuen Zeilen.

## Dateien

| Datei | Inhalt |
|---|---|
| `manifest.json` | Manifest V3. Berechtigungen: nur `storage` + `https://www.cardmarket.com/*` |
| `parser.js` | **Alle Selektoren (Konstante `SELECTORS`)**, Preis-Parser, Auslesen der Seite |
| `shared.js` | Einstellungen, Porto, Bewertung, Watchlist/Deckliste, Bündelung (von Seite und Popup genutzt) |
| `content.js` | Markierungen, Zusammenfassung, Watchlist-Bedienung, Preisverlauf speichern, MutationObserver |
| `styles.css` | Styles (alle Klassen mit `mtgds-`-Präfix, für helles und dunkles Cardmarket-Theme) |
| `popup.html` / `popup.js` | Tabs Watchlist, Bündeln, Einstellungen |
| `sample.html` | Gespeicherte Beispielseite (Chrommox, Mirrodin), aus der die Selektoren abgeleitet sind |
| `test/` | Tests in headless Chrome (gehört nicht zur Extension-Logik) |

**Speicher**

- `chrome.storage.sync` (geräteübergreifend): `settings`, Watchlist-Einträge `wl:<kartenname>`
- `chrome.storage.local` (nur dieser Rechner): Preisverlauf `hist:<druck>`, Angebots-Schnappschüsse
  `snap:<druck>` (nur für offene Watchlist-Karten, max. 40 Angebote, nach 30 Tagen gelöscht)
- Watchlist-Einträge aus Version 1.0 (pro Druck) werden automatisch auf das neue Format umgestellt.

## Wenn Cardmarket das Layout ändert

Alle Selektoren stehen oben in **`parser.js`** in `SELECTORS`, die Beschriftungen der Info-Box
in `LABEL_PATTERNS`. Findet ein Selektor nichts, wirft die Extension keinen Fehler und lässt die
Seite unverändert. In der DevTools-Konsole (F12) erscheint dann eine Warnung mit dem Präfix
`[MTG Deal Sniper]`, die den betroffenen Selektor nennt.

Vorgehen:
1. Kartenseite in Chrome speichern (Strg+S, „Webseite, vollständig“) und als neues `sample.html` ablegen.
2. In DevTools die betroffene Stelle untersuchen und den Selektor in `SELECTORS` anpassen.
3. Tests laufen lassen (siehe unten).

Verifiziert sind aus der Beispielseite die Kartensprachen „Deutsch“/„Englisch“ und das Land
„Deutschland“. Die übrigen Sprach- und Ländernamen (`LANGUAGES` in `parser.js`, `COUNTRIES` in
`shared.js`) sind eingetragen, aber noch nicht an echten Angeboten geprüft. Bei einem unbekannten
Sprachnamen erscheint eine Konsolenwarnung. Ein unbekanntes Land wird beim Porto als Ausland gerechnet.

## Tests

```powershell
powershell -ExecutionPolicy Bypass -File test\run-test.ps1
# optional mit den Assets der gespeicherten Seite für einen gestylten Screenshot:
powershell -ExecutionPolicy Bypass -File test\run-test.ps1 -AssetsDir "<Pfad>\..._files"
```

Das Skript baut Testkopien von `sample.html` und `popup.html` mit einem `chrome.storage`-Ersatz
(`test/chrome-shim.js`) und Startdaten (`test/page-seed.js`, `test/popup-seed.js`; die Popup-Daten
sind erfunden). Cardmarkets eigene Skripte werden entfernt, damit keine Netzwerkzugriffe stattfinden.
Die Ausführung läuft in headless Chrome. Ausgegeben werden:

- Unit-Tests: Preis-Parser, Deckliste, Kartenschlüssel, Porto, Referenzpreis, Verkäuferfilter, Bündelung
- alle Angebote der Beispielseite mit Porto, Gesamtpreis, Rabatt und Bewertung
- Ergebnis von `content.js` vor und nach einer simuliert nachgeladenen Zeile (69,00 €)
- Speicher nach Migration, Preisverlauf, Schnappschuss
- Screenshots: `test/screenshot.png`, `test/popup-watch.png`, `popup-bundle.png`, `popup-settings.png`, `popup-import.png`
