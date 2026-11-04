/**
 * Voneinander unabhängige Erkennungsstrategien für Marktsignale.
 * Jede Strategie liefert eine Einkaufsbasis + Begründung, wenn sie anschlägt.
 * (Strategie 1 – Einzelangebote – steckt in services/offers.ts, weil sie beobachtete Angebote braucht.
 *  Strategie 5 – Bündelung – in services/bundles.ts; Strategie 6 – Ranking – in services/analysis.ts.)
 */
import type { AppSettings } from '../domain/settings.ts';
import type { GuidePrices, SnapshotPoint, Strategy } from '../domain/types.ts';
import { round1 } from '../util/num.ts';
import type { BuyBasis } from './opportunity.ts';
import { CONDITION_MIX } from './resale.ts';
import { guideMetrics, historyMetrics } from './stats.ts';

export interface StrategyHit { strategy: Strategy; buy: BuyBasis; triggers: string[]; confidenceDelta?: number; confidenceNote?: string }

function marketBasis(price: number, label: string, g: GuidePrices, condition: string | null): BuyBasis {
  return {
    price, shipping: null, label, observedAt: g.sourceCreatedAt, source: 'cardmarket_price_guide',
    condition, language: null, offerId: null, offerUrl: null, seller: null, sellerCountry: null,
    sellerType: null, sellerSales: null, amount: null, previousPrice: null,
  };
}

/**
 * Strategie 2 – Price-Dip: dokumentierte Preisindikatoren sind ungewöhnlich stark gegenüber
 * der eigenen Vergangenheit gefallen. Einkaufsbasis: 1-Tages-Ø (zu diesem Preis wurde gestern
 * im Schnitt tatsächlich verkauft), ersatzweise der aktuelle Trend bei belegtem Rückgang der eigenen Historie.
 */
export function priceDip(g: GuidePrices, series: SnapshotPoint[], s: AppSettings): StrategyHit | null {
  const gm = guideMetrics(g);
  const hm = historyMetrics(series, s.analysis.volatilityMinDays);
  const th = -s.analysis.dipThresholdPct;
  const triggers: string[] = [];
  if (gm.avg1VsAvg30Pct != null && gm.avg1VsAvg30Pct <= th) triggers.push(`1-Tages-Ø ${round1(gm.avg1VsAvg30Pct)} % unter 30-Tages-Ø (Cardmarket-Aggregat).`);
  if (hm.change7d.value != null && hm.change7d.value <= th) triggers.push(`Trend in 7 Tagen ${hm.change7d.value} % (eigene Historie).`);
  if (hm.z30.value != null && hm.z30.value <= -2) triggers.push(`Trend ${hm.z30.value} Standardabweichungen unter dem 30-Tage-Mittel.`);
  if (!triggers.length) return null;
  // Der 1-Tages-Ø kann auf einem einzigen Verkauf beruhen. Ohne Bestätigung durch den 7-Tages-Ø
  // oder die eigene Historie gilt der Rückgang als unbestätigt.
  const historyConfirms = triggers.length > 1 || !(gm.avg1VsAvg30Pct != null && gm.avg1VsAvg30Pct <= th);
  if (hm.reversal) triggers.push('Mögliche Preisumkehr: nach mehreren Rückgängen zuletzt wieder gestiegen.');
  const price = g.avg1 ?? g.trend;
  if (price == null) return null;
  const avg7Confirms = gm.avg7VsAvg30Pct != null && gm.avg7VsAvg30Pct <= th / 3;
  const hit: StrategyHit = { strategy: 'price_dip', buy: marketBasis(price, g.avg1 != null ? '1-Tages-Ø (Marktsignal)' : 'Trendpreis (Marktsignal)', g, CONDITION_MIX), triggers };
  if (!historyConfirms && !avg7Confirms) {
    hit.confidenceDelta = -10;
    hit.confidenceNote = 'Rückgang nur im 1-Tages-Ø (evtl. Einzelverkauf), nicht durch 7-Tages-Ø oder Historie bestätigt';
  }
  return hit;
}

/**
 * Strategie 3 – Volatilität: nur mit ausreichender eigener Historie. Volatilität allein ist
 * kein Signal – zusätzlich muss der aktuelle Preis im unteren Bereich der eigenen Spanne liegen
 * und der Median der Spanne ausreichend darüber.
 */
export function volatilityScan(g: GuidePrices, series: SnapshotPoint[], s: AppSettings): StrategyHit | null {
  const hm = historyMetrics(series, s.analysis.volatilityMinDays);
  if (hm.vol30.value == null || hm.range30 == null || g.trend == null) return null;
  const r = hm.range30;
  const upside = (r.median - g.trend) / g.trend * 100;
  if (hm.vol30.value < 3 || r.percentile > 25 || upside < s.rules.minDiscountPct) return null;
  return {
    strategy: 'volatility',
    buy: marketBasis(g.trend, 'Trendpreis im unteren Bereich der Schwankung (Marktsignal)', g, CONDITION_MIX),
    triggers: [
      `Tagesvolatilität ${hm.vol30.value} % über ${hm.vol30.n} Tage.`,
      `Aktueller Trend im unteren ${Math.round(r.percentile)} %-Bereich der 30-Tage-Spanne (${r.min.toFixed(2)}–${r.max.toFixed(2)} €), Median ${round1(upside)} % darüber.`,
    ],
  };
}

/**
 * Strategie 4 (Marktsignal-Variante) – Spread zwischen gemeldetem Tiefstpreis und konservativ
 * geschätztem Wiederverkauf. Der Tiefstpreis kann ein Angebot in schlechtem Zustand oder anderer
 * Sprache sein und muss nicht mehr verfügbar sein → niedrige Confidence, nie ein Kaufauftrag.
 */
export function spreadLow(g: GuidePrices, s: AppSettings): StrategyHit | null {
  if (g.low == null || g.trend == null) return null;
  const gm = guideMetrics(g);
  if (gm.lowVsTrendPct == null || gm.lowVsTrendPct > -s.rules.minDiscountPct) return null;
  return {
    strategy: 'spread_low',
    buy: marketBasis(g.low, 'gemeldeter Tiefstpreis (Marktsignal, Zustand/Sprache unbekannt)', g, null),
    triggers: [`Gemeldeter Tiefstpreis ${round1(gm.lowVsTrendPct)} % unter Trend zum Zeitpunkt der Price-Guide-Erstellung.`],
  };
}
