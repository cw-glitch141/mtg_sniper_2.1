# Datenzugangs-Realitätscheck (Stand 2026-11-04)

Frage: Welche legitime Quelle liefert **automatisch neue Einzelangebote** (mit Angebots-ID, Verkäufer, Preis,
Zustand, Sprache und Link), wie aktuell und mit welchem Limit?

Kurzantwort:

- **Cardmarket**: Es gibt derzeit keine zulässige Quelle für automatische Einzelangebote. Die API nimmt keine
  neuen Anträge an, und der Price Guide enthält nur tägliche Aggregate.
- **CardTrader** (ein anderer Marktplatz): Eine offizielle API mit Einzelangeboten ist dokumentiert. Sie funktioniert
  mit dem **eigenen** Token. Der Adapter dafür ist implementiert, aber **noch nicht live verifiziert**, weil kein
  Token vorliegt.
- Alles andere, was gefunden wurde, sind Preisaggregate oder Zugänge, die für neue Entwickler geschlossen sind.

## Übersicht

| Quelle | Einzelangebote? | Neue Angebote automatisch? | Aktualität | Zugang | Limits | Bewertung |
|---|---|---|---|---|---|---|
| Cardmarket API (MKM) | ja, für zugelassene Apps | ja | live | **keine neuen Anträge** | – | **blockiert** (`blocked-by-provider`) |
| Cardmarket Price Guide (S3) | nein, Aggregate (Trend, Ø 1/7/30, Tiefstpreis) | nein | 1× täglich | öffentlich | – | nur **Market Watch / Recherche** |
| CardTrader API v2 | ja, bis zu 25 günstigste je Blueprint | ja (Polling) | bei der Abfrage gelesen; Cache-Verhalten der Quelle **unbekannt** | eigenes Token aus dem Profil | 200 Anfragen/10 s gesamt, Marketplace 10/s (Drittquellen) | **Adapter implementiert, nicht verifiziert** |
| TCGplayer API | ja | ja | live | **keine neuen Zugänge** | – | blockiert, außerdem US-Markt/USD |
| eBay Browse API | ja (Auktionen/Sofortkauf) | ja (Polling) | live | Produktionszugang zu Buy-APIs eingeschränkt, Antrag nötig | Forum: ca. 5.000 Aufrufe/Tag (nicht offiziell bestätigt) | nicht umgesetzt (Begründung unten) |
| Scryfall | nein, Tagespreise (aggregiert) | nein | 1× täglich | öffentlich | 10/s empfohlen | nur Zuordnung (Set, Nummer, Bild) |
| MTGJSON | nein, Tagespreise | nein | 1× täglich | öffentlich | – | nicht genutzt |
| Kommerzielle „TCG-Preis-APIs“ | meist Aggregate oder gecachte Preise | nein | stündlich bis täglich | kostenpflichtig | je Tarif | **kein Live-Feed**; Herkunft und Nutzungsrechte vor einer Nutzung einzeln prüfen |
| Browser-Erweiterung (eigene) | ja, aber nur Seiten, die du selbst öffnest | **nein** | Zeitpunkt deines Besuchs | lokal | – | bleibt als **optionaler manueller Zusatz** |

## Cardmarket

- Die [Hilfeseite zur Cardmarket-API](https://help.cardmarket.com/en/cardmarket-api) sagt: Derzeit werden keine Anträge
  auf API-Zugang angenommen. Bestehende Nutzer dürfen ihre Zugangsdaten nicht an Dritte oder Drittsoftware weitergeben.
- Die [API-Dokumentation](https://apiv2.cardmarket.com/ws/documentation/API:Auth_Overview) beschränkt Zugänge auf
  professionelle Verkäufer mit manueller Freigabe.
- Ein Wiedereröffnungstermin war nicht zu finden.
- Der öffentliche Price Guide wird einmal täglich erzeugt. Er enthält **keine** Einzelangebote und trennt nicht nach
  Zustand oder Sprache. Der „Tiefstpreis“ darin kann ein Angebot in schlechtem Zustand oder anderer Sprache sein und
  muss nicht mehr verfügbar sein.
- Die Nutzungsbedingungen-Seiten von Cardmarket lieferten automatischen Abrufen HTTP 403/410. Sie müssen eingeloggt
  selbst gelesen werden.
- **Konsequenz:** Die Software meldet wörtlich *„Automatische Cardmarket-Angebotsüberwachung nicht verfügbar – keine
  Live-Datenquelle verbunden“*. Es gibt kein Scraping, keine Umgehung von Zugriffsschutz und keine fremden Sessions oder Tokens.

## CardTrader (einzige gefundene zulässige Listing-Quelle)

Was die Recherche ergab:

- Die offizielle Referenz unter `cardtrader.com/…/docs/api/full/reference` antwortete automatischen Abrufen mit HTTP 403.
  Die folgenden Angaben stammen deshalb aus Suchergebnis-Auszügen dieser Referenz und aus zwei Open-Source-Clients
  ([Eomm/cardtrader-api-skills](https://github.com/Eomm/cardtrader-api-skills),
  [nicho92/cardtrader-api-java](https://github.com/nicho92/cardtrader-api-java)).
- Basis-URL `https://api.cardtrader.com/api/v2`. Authentifizierung mit `Authorization: Bearer <Token>`, das Token steht
  in den **eigenen** Profileinstellungen.
- `GET /marketplace/products?blueprint_id=…` liefert `{ "<blueprint_id>": [Angebote] }` mit bis zu 25 Angeboten,
  nach Preis sortiert. Jedes Angebot enthält `id`, `price.cents`, `price.currency`, `quantity`,
  `properties_hash.condition | mtg_language | mtg_foil | signed | altered`, `user.username | country_code | user_type`,
  `on_vacation`, `graded` und `bundle_size`.
- Blueprints (`GET /blueprints/export?expansion_id=…`) enthalten `card_market_ids`. Damit ist die **exakte
  Cardmarket-Druckvariante** zuordenbar.
- Rate-Limits laut den Auszügen: 200 Anfragen je 10 Sekunden gesamt, Marketplace 10 Anfragen je Sekunde.
  Der Adapter nutzt standardmäßig 4/s und ein Budget je Lauf.

Was offen ist und vor dem Vollbetrieb **von dir** geprüft werden muss:

1. **Nutzungsbedingungen** der CardTrader-API eingeloggt lesen: erlaubte Nutzung, automatisches Polling, Weiterverarbeitung.
   Erst danach in den Einstellungen `live.cardtrader.termsConfirmed` setzen. Ohne diese Bestätigung bleibt der Adapter aus.
2. Feldnamen und Limits beim ersten echten Lauf bestätigen. Der Adapter ist gegen die recherchierten Antwortformen
   getestet, nicht gegen die echte API.
3. **Kein Porto je Angebot** in der API (Versand je Verkäufer, eigener Hub „CardTrader Zero“). Die App schätzt das Porto
   aus deinen Porto-Einstellungen und kennzeichnet das.
4. **Kein Deeplink je Angebot** bekannt. Der Link führt zur Kartenseite (`https://www.cardtrader.com/cards/{blueprint_id}`,
   Vorlage einstellbar). Angebots-ID und Verkäufer stehen im Alarm. Das Linkformat ist unverifiziert.
5. Aktualität: Die Daten werden bei jeder Abfrage gelesen. Ob CardTrader serverseitig cacht, ist nicht dokumentiert.
   Die App misst die Verzögerung selbst (siehe unten).
6. **Abdeckung:** nur der CardTrader-Marktplatz, nicht Cardmarket. Einkauf dort und Verkauf auf Cardmarket bedeutet
   andere Gebühren und Versandwege. Je Variante sieht man nur die 25 günstigsten Angebote, was für die Deal-Suche aber
   der relevante Teil ist.
7. Zustandsskalen unterscheiden sich. Die Abbildung ist eine **Annahme**: Mint→MT, Near Mint→NM, Slightly Played→EX,
   Moderately Played→GD, Played→LP, Heavily Played→PL, Poor→PO. Unbekannte Werte führen zu „Prüfung“, nicht zu einem Kauf.

## eBay Browse API – warum (noch) nicht umgesetzt

- Die API ist offiziell und angebotsgenau, aber der Produktionszugang zu den Buy-APIs ist eingeschränkt und braucht
  einen Antrag. Ein Forumsbeitrag nennt ca. 5.000 Aufrufe pro Tag, das ist nicht offiziell bestätigt.
- Angebote sind Freitext-Titel. Die exakte Druckvariante, der Zustand und die Sprache lassen sich nicht verlässlich
  bestimmen. Das widerspricht der Anforderung „exakte Variante“.
- Möglich, wenn gewünscht: ein Adapter mit strenger Titelprüfung, bei dem alles Unklare auf „Prüfung“ gesetzt wird.

## Was die App jetzt tut

- `server/src/providers/listings.ts`: allgemeine Feed-Schnittstelle mit Feldern für Quelle, Autorisierung, Produkt,
  Finish, Angebots-ID, Verkäufer, Preis, Währung, Zustand, Sprache, Menge, Porto, Link, Quell-Zeitstempel, Abrufzeit
  und Ablaufzeit. Dazu kommen Health-Daten: Rate-Limit-Treffer, letzter Erfolg, Abdeckung und Fehler.
- `server/src/providers/cardtrader.ts`: der CardTrader-Adapter. Er liest nur und enthält keine Kauf- oder
  Warenkorbfunktionen.
- `server/src/providers/mockListings.ts`: ein TEST-Feed, der ausschließlich SIMULATION-Daten erzeugt. Er wird nur über
  `MTGDS_MOCK_FEED=1` oder in Tests aktiv.
- Die Messung erfolgt im Live-Radar: Verzögerung (exakt nur mit Quell-Zeitstempel, sonst als Obergrenze „Zeit seit der
  vorherigen Abfrage“), Abdeckung (abgefragt / mit Angeboten / nicht abgedeckt) und ein Fehlalarm-Indikator
  (Live-Alarme, die danach abgelehnt wurden).

## Was für den Vollbetrieb fehlt

| Voraussetzung | Wer | Kosten |
|---|---|---|
| CardTrader-Konto und eigenes API-Token in `.env` (`CARDTRADER_TOKEN`) | du | laut Recherche kostenlos, bitte prüfen |
| CardTrader-API-Bedingungen lesen und bestätigen | du | – |
| Erster echter Lauf: Felder, Linkformat und Limits verifizieren, Ergebnis im CHANGELOG festhalten | du + Entwicklung | – |
| Nachweis mit **realen Angebots-IDs** und mindestens einem beobachteten neuen bzw. reduzierten Angebot | Betrieb | – |
| Cardmarket-Angebote automatisch: nur mit eigener, zugelassener Cardmarket-API | Cardmarket | zurzeit nicht möglich |

Bis diese Punkte erfüllt sind, ist die **autonome Sniper-Funktion nicht fertig**. Status: „Adapter implementiert“,
nicht „Live-Feed angeschlossen“.
