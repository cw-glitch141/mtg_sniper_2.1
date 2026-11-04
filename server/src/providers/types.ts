/**
 * Austauschbare Datenanbieter-Schnittstellen.
 *
 * Heute angebunden:
 *   - CatalogProvider  'cardmarket_s3'    (öffentlicher Produktkatalog)
 *   - PriceProvider    'cardmarket_s3'    (öffentlicher täglicher Price Guide, aggregiert, KEINE Echtzeit-Angebote)
 *   - MappingProvider  'scryfall'         (Set-Code, Collector Number, Seltenheit, Bild)
 *   - Angebote         'extension' / 'manual' / 'simulation' über POST /api/offers
 *
 * Für einen später zugelassenen Live-Angebotsfeed (offizielle Cardmarket-API oder lizenzierter Feed)
 * wird ein OfferProvider implementiert und in providers/registry.ts eingetragen. Der Rest der
 * Anwendung (Bewertung, Alerts, Dashboard) arbeitet bereits mit dem allgemeinen Angebotsformat.
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
}

export interface OfferProvider {
  id: string;                         // z. B. 'api:cardmarket' – wird als Angebotsquelle gespeichert
  signalClass: 'LIVE_OFFER';
  /** Aktuelle Angebote für die angegebenen Produkte abrufen (nur mit gültiger Zulassung!). */
  fetchOffers(productExternalIds: number[]): Promise<OfferInput[]>;
}
