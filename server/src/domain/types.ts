/**
 * Zentrale Typen. Die Signalklassen sind bewusst strikt getrennt:
 *   MARKET_SIGNAL – Erkenntnis aus aggregierten/historischen Preisdaten. KEIN kaufbares Angebot.
 *   LIVE_OFFER    – tatsächlich beobachtetes Einzelangebot (Zeitpunkt der Beobachtung angegeben).
 *   SIMULATION    – Testdaten ohne Kaufmöglichkeit.
 */
export type SignalClass = 'MARKET_SIGNAL' | 'LIVE_OFFER' | 'SIMULATION';
export type Finish = 'nonfoil' | 'foil';
export type Condition = 'MT' | 'NM' | 'EX' | 'GD' | 'LP' | 'PL' | 'PO';
export const CONDITIONS: Condition[] = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];

export type Strategy = 'underpriced_offer' | 'price_dip' | 'volatility' | 'spread_low';
export const STRATEGY_LABELS: Record<Strategy, string> = {
  underpriced_offer: 'Unterbewertetes Einzelangebot',
  price_dip: 'Price-Dip',
  volatility: 'Volatilität',
  spread_low: 'Spread zum gemeldeten Tiefstpreis',
};

export type Recommendation = 'KAUFEN' | 'PRÜFEN' | 'NICHT KAUFEN';

/** Werte aus dem Cardmarket Price Guide für eine Variante (product + finish). */
export interface GuidePrices {
  avg: number | null;
  low: number | null;
  trend: number | null;
  avg1: number | null;
  avg7: number | null;
  avg30: number | null;
  sourceCreatedAt: string;
}

export interface SnapshotPoint {
  date: string; // YYYY-MM-DD
  trend: number | null;
  avg1: number | null;
  avg7: number | null;
  avg30: number | null;
  low: number | null;
}

export interface ProductInfo {
  id: number;
  externalId: number;
  name: string;
  setName: string | null;
  setCode: string | null;
  collectorNumber: string | null;
  rarity: string | null;
  imageUrl: string | null;
  mappingStatus: string;
}

export interface ObservedOffer {
  id: number;
  source: string;
  signalClass: 'LIVE_OFFER' | 'SIMULATION';
  externalId: string;
  productId: number | null;
  productName: string | null;
  expansionName: string | null;
  finish: Finish;
  condition: Condition | null;
  language: string | null;
  price: number;
  amount: number | null;
  seller: string | null;
  sellerCountry: string | null;
  sellerType: string | null;
  sellerSales: number | null;
  url: string | null;
  observedAt: string;
  previousPrice: number | null;
}
