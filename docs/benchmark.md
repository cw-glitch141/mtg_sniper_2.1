# Konkurrenzanalyse & Feature-Benchmark (Stand 04.11.2026)

Grundlage sind ausschließlich die öffentlich zugänglichen Seiten der Anbieter (abgerufen am 04.11.2026).
„nicht dokumentiert“ heißt: auf den gelesenen Seiten nicht beschrieben – nicht, dass es die Funktion nicht gibt.
Es wurden keine fremden Implementierungen, privaten Endpunkte oder Zugänge verwendet.

Gelesene Seiten: tcgsniper.nl (Start, /pricing) · cardtracker.io (Start, /features, /faq) · tcgpowertools.com (Start).

## Vergleichsmatrix

| Funktion | TCGSniper | CardTracker | TCG PowerTools | MTG Deal Sniper 2.1 |
|---|---|---|---|---|
| Schwerpunkt | Restock-Alerts für Sealed-Produkte bei 100+ NL/BE-Webshops | Neue Cardmarket-Listings für Pokémon-Singles | Bestands- und Listing-Manager für Händler, Multi-TCG | Deal-Erkennung + Handelsmanagement für MTG-Singles |
| Preisalarme | ja (Premium: Preisgrenze je Produkt) | Deal-Flag ggü. Marktwert | nicht dokumentiert | ja, 3 Prioritäten, Watchlist-Zielpreise, Dedupe/Cooldown |
| Angebotserkennung | Shop-Monitoring (Methode nicht dokumentiert), Browser-Extension „QuickSnipe“ | liest öffentliche Cardmarket-Seiten selbst („reads them the way a real buyer's browser does“), laut FAQ unabhängig von Cardmarket | nicht dokumentiert | nur selbst geöffnete Seiten (Extension, Opt-in) + manueller Import; Marktsignale aus offiziellem Price Guide. **Kein Crawling.** |
| Watchlists | ja; Cardmarket-Wishlist (VIP) | Karten einfügen, Filter Sprache/Mindestzustand | nicht dokumentiert | mehrere Listen, Zielpreise, Druck- oder Namensbezug |
| Verkäufer-Bündelung | eigene Bundles („Eén melding zodra alles samen op voorraad is“) | nicht dokumentiert | nicht dokumentiert | Watchlist-Bündel + profitable Live-Angebote je Verkäufer |
| Warenkorb | Warenkorb-Befüllung über QuickSnipe („bestelt en betaalt nooit“) | kauft nicht | nicht dokumentiert | bewusst nein (kein Auto-Kauf, keine Warenkorbbefüllung) |
| Preisverlauf | Premium: Verlauf, Tiefstwert, Median | Datenbank mit allen Beobachtungen (Nutzersicht unklar) | nicht dokumentiert | eigene tägliche Snapshots, 1/7/30-Tage, Volatilität |
| Verkaufsverwaltung | nicht dokumentiert | nicht dokumentiert | nicht dokumentiert | Aufträge, Status, Zahlung, Retouren, Archiv |
| Bestandsmanagement | nicht dokumentiert | nicht dokumentiert | „search and modify large inventories in real-time“ | Chargen, Lagerplätze, FIFO, Reservierungen, Privat/Geschäft getrennt |
| Repricing | nicht dokumentiert | nicht dokumentiert | „Pricing Bot … will update your cards every night“, Strategien je Teilmenge | Vorschläge mit Verlustgrenze/Zielpreis, keine Ausführung ohne Schnittstelle |
| Mindestpreis-Grenzen | – | – | nicht dokumentiert | ja (Verlustgrenze aus Einstand + Gebühren + Steuer, absolut, je Charge) |
| Marktplätze | Webshops; Cardmarket nur Wishlist/Alerts | Cardmarket, eBay „soon“ | nicht explizit (Cardmarket-Partnerlogo auf der Startseite) | Cardmarket-Daten; Plattformfeld je Auftrag/Angebot vorbereitet |
| Automatisierung | Live-Feed, Push | Push/Mail, Tages-Digest | CSV-Import „will automatically publish the cards to your account“, Tastaturkürzel | Picklisten, Scan-Checkliste, QR-Etiketten, CSV-Import/-Export |
| Benachrichtigung | App-Push, Web-Feed, Discord | Push, E-Mail | nicht dokumentiert | Dashboard, Desktop, Telegram, Discord |
| Cardmarket-Integration | nicht dokumentiert | ausdrücklich keine (eigenes Auslesen) | Partnerlogo, API nicht beschrieben | offizielle öffentliche Dateien; Schnittstelle für zugelassene API vorbereitet |
| Preis | 0 / 2,49 / 3,99 €/Monat | Beta kostenlos, später 9–95 €/Monat | nicht auf der Startseite | eigene lokale Software |

## Übernommene Ideen (ohne fremden Code)

| Idee | Quelle | Umsetzung in 2.1 |
|---|---|---|
| Repricing nach Regeln für Teilmengen, nächtlich | TCG PowerTools | Repricing-Engine mit Befunden (zu teuer, zu günstig, lange unverkauft, unter Verlustgrenze) – als **Vorschlag**, CSV-Arbeitsliste |
| Bulk-Arbeit per CSV | TCG PowerTools | standardisierte CSV-Importe (Aufträge, Angebote) und -Exporte (Bestand, Aufträge, Preisvorschläge) |
| Schnelle Bedienung (Tastatur) | TCG PowerTools | Scan-Felder (Enter) in Lager, Versand und Auftragserfassung, QR-Etiketten mit Bestands-ID |
| Preisverlauf mit Tiefstwert/Median | TCGSniper | bereits in 2.0 (eigene Historie, Spanne, Median) |
| Watchlist-Filter je Eintrag (Sprache, Mindestzustand) | CardTracker | umgesetzt: Mindestzustand und Sprachen je Eintrag (leer = globale Kaufregel), wirken auf Watchlist-Alarme und Watchlist-Bündelung |
| Bundle-Benachrichtigung „alles zusammen verfügbar“ | TCGSniper | Watchlist-Bündelung zeigt Verkäufer mit mehreren offenen Karten |

## Bewusst **nicht** übernommen

- Eigenes Auslesen/Crawlen von Cardmarket-Listings (CardTracker): ohne geklärte Erlaubnis ausgeschlossen.
- Warenkorbbefüllung (TCGSniper QuickSnipe): ausgeschlossen (keine ungefragten Käufe/Warenkörbe).
- Automatisches Veröffentlichen von Preisen/Listings (PowerTools): nur mit offiziell zugelassener Marktplatz-Schnittstelle.

## Offizielle Integrationen

Für Cardmarket-Bestellungen, -Bestand und -Preisänderungen wäre die offizielle Cardmarket-API nötig (Zulassung
erforderlich; die öffentliche Doku-Seite antwortete am 04.11.2026 mit HTTP 410). Sobald eine Zulassung vorliegt,
lassen sich Auftrags-Import, Bestandsabgleich und Repricing-Ausführung als Provider anschließen
(siehe README → „Offene Schnittstellen“).
