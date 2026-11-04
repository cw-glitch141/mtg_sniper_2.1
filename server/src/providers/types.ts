/**
 * Austauschbare Datenanbieter-Schnittstellen.
 *
 * Heute angebunden:
 *   - CatalogProvider  'cardmarket_s3'    (öffentlicher Produktkatalog)
 *   - PriceProvider    'cardmarket_s3'    (öffentlicher täglicher Price Guide, aggregiert, KEINE Echtzeit-Angebote)
 *   - MappingProvider  'scryfall'         (Set-Code, Collector Number, Seltenheit, Bild)
 *   - Angebote         'extension' / 'manual' / 'simulation' über POST /api/offers
 *   - Listing-Feeds    providers/listings.ts (ListingProvider), z. B. 'api:cardtrader' – nur mit
 *                      eigenem Token und bestätigten Nutzungsbedingungen aktiv; 'test:mock-feed' nur für Tests.
 * Alle Quellen münden in dasselbe Angebotsformat (OfferInput) und dieselbe Bewertung.
 */
import type { Condition, Finish } from '../domain/types.ts';
import type { Conditional, HttpMeta } from './http.ts';

export interface CatalogProduct {
  externalId: number;
  name: string;
  expansionExternalId: number | null;
  metacardId: number | null;
  dateAdded: string | null;
}

export interface PriceRow {
  externalId: number;
  categoryId: number | null;
  nonfoil: { avg: number | null; low: number | null; trend: number | null; avg1: number | null; avg7: number | null; avg30: number | null };
  foil: { avg: number | null; low: number | null; trend: number | null; avg1: number | null; avg7: number | null; avg30: number | null };
}

export type Fetched<T> = { notModified: true; meta: HttpMeta } | { notModified: false; meta: HttpMeta; createdAt: string; items: T[]; raw: string };

export interface CatalogProvider {
  id: string;
  gameId: string;
  fetchCatalog(cond?: Conditional): Promise<Fetched<CatalogProduct>>;
}

export interface PriceProvider {
  id: string;
  gameId: string;
  /** URL für eine leichte Änderungsprüfung (HEAD), falls unterstützt. */
  checkUrl?: string;
  fetchPrices(cond?: Conditional): Promise<Fetched<PriceRow>>;
}

/** Allgemeines Eingangsformat für beobachtete Einzelangebote – egal aus welcher Quelle. */
export interface OfferInput {
  externalId?: string | null;
  productExternalId?: number | null;
  productName?: string | null;
  expansionName?: string | null;
  finish?: Finish;
  condition?: Condition | string | null;
  language?: string | null;
  price: number;
  amount?: number | null;
  seller?: string | null;
  sellerCountry?: string | null;
  sellerType?: string | null;
  sellerSales?: number | null;
  url?: string | null;
  observedAt?: string | null;
  // --- ab 2.2, nur von Listing-Feeds gesetzt (Extension/CSV bleiben unverändert gültig) ---
  currency?: string | null;
  /** Porto je Karte laut Quelle; null/fehlend = aus den Porto-Einstellungen schätzen. */
  shipping?: number | null;
  sourceTimestamp?: string | null;
  fetchedAt?: string | null;
  expiresAt?: string | null;
  sourceAuthorized?: boolean | null;
  reviewStatus?: 'ok' | 'review' | null;
  reviewReasons?: string[] | null;
}
