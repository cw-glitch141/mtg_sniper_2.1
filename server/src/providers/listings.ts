/**
 * Schnittstelle für angebotsgenaue Datenquellen (Listing-Feeds).
 *
 * Ein Feed liefert konkrete, kaufbare Einzelangebote mit eigener Angebots-ID – im Gegensatz zum
 * Cardmarket Price Guide, der nur tägliche Aggregate enthält. Ein Adapter darf nur Daten abrufen,
 * die der Anbieter für diesen Zweck ausdrücklich bereitstellt (offizielle API, eigenes Token,
 * dokumentierte Rate-Limits). Kein Scraping, keine fremden Sessions oder Tokens.
 *
 * "Adapter implementiert" ist NICHT "Feed angeschlossen": readiness() sagt, ob die Quelle
 * konfiguriert und vom Besitzer freigegeben ist; erst ein erfolgreicher Lauf belegt den Anschluss.
 */
import type { Finish } from '../domain/types.ts';

/** Eine überwachte Kartenvariante (Cardmarket-Produkt + Finish). */
export interface ListingTarget {
  productId: number;          // interne ID
  externalId: number;         // Cardmarket idProduct
  finish: Finish;
  name: string;
  setCode: string | null;
  collectorNumber: string | null;
}

export const targetKey = (t: { productId: number; finish: string }) => `${t.productId}:${t.finish}`;

/** Ein konkretes Angebot, wie es der Feed liefert (vor Validierung). */
export interface ListingRecord {
  source: string;
  sourceAuthorized: boolean;
  productExternalId: number;  // Cardmarket idProduct (exakte Druckvariante)
  targetKey: string | null;   // zu welcher überwachten Variante die Antwort gehört
  finish: Finish | null;
  listingId: string | null;
  seller: string | null;
  sellerCountry: string | null;
  sellerType: string | null;
  price: number | null;       // je Stück
  currency: string | null;
  condition: string | null;   // bereits auf Cardmarket-Kürzel abgebildet (MT/NM/EX/…), sonst null
  language: string | null;    // ISO-Kürzel wie en/de
  quantity: number | null;
  shipping: number | null;    // null = Quelle liefert kein Porto je Angebot
  listingUrl: string | null;
  sourceTimestamp: string | null; // Zeitstempel der Quelle (falls geliefert)
  fetchedAt: string;
  expiresAt: string | null;
  flags: string[];            // z. B. 'signed', 'altered', 'graded' → Prüfung nötig
}

export interface ProviderReadiness {
  configured: boolean;        // technische Voraussetzungen (Token usw.) vorhanden
  authorized: boolean;        // Besitzer hat Nutzungsbedingungen bestätigt und Quelle aktiviert
  reason: string | null;      // warum nicht bereit
}

export interface FetchListingsResult {
  listings: ListingRecord[];
  covered: string[];          // targetKeys, für die der Feed geantwortet hat
  unsupported: { key: string; reason: string }[]; // Varianten, die die Quelle nicht abdeckt
  requests: number;
  rateLimited: boolean;
  errors: string[];
}

export interface ListingProvider {
  id: string;                 // wird als Angebotsquelle gespeichert, z. B. 'api:cardtrader'
  label: string;
  kind: 'licensed_api' | 'test';
  /** LIVE_OFFER nur für echte, autorisierte Quellen; Test-Feeds liefern ausschließlich SIMULATION. */
  signalClass: 'LIVE_OFFER' | 'SIMULATION';
  limits: string;             // dokumentierte Rate-Limits (Klartext)
  coverage: string;           // was der Feed abdeckt – und was nicht
  readiness(): ProviderReadiness;
  fetchListings(targets: ListingTarget[], opts: { budget: number; signal?: AbortSignal }): Promise<FetchListingsResult>;
}

/** Abbildung typischer Zustandsbezeichnungen auf Cardmarket-Kürzel. Unbekanntes bleibt null (→ Prüfung). */
export function mapCondition(raw: unknown): string | null {
  const v = String(raw ?? '').trim().toLowerCase();
  const map: Record<string, string> = {
    mint: 'MT', mt: 'MT', 'near mint': 'NM', nm: 'NM',
    // CardTrader-Skala → Cardmarket-Skala. Annahme, siehe docs/datenquellen.md.
    'slightly played': 'EX', excellent: 'EX', ex: 'EX',
    'moderately played': 'GD', good: 'GD', gd: 'GD',
    played: 'LP', 'light played': 'LP', lp: 'LP',
    'heavily played': 'PL', pl: 'PL', poor: 'PO', po: 'PO',
  };
  return map[v] ?? null;
}
