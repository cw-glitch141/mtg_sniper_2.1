/**
 * Baut aus Produkt-, Preis- und (optional) Angebotsdaten eine vollständig begründete
 * Handelsmöglichkeit: Einkauf, drei Verkaufsszenarien, Kennzahlen, Regeln, Score, Empfehlung.
 */
import type { AppSettings, Priority } from '../domain/settings.ts';
import type { Exposure } from './rules.ts';
import { shippingCost } from '../domain/shipping.ts';
import {
  STRATEGY_LABELS, type Evidence, type Finish, type GuidePrices, type ProductInfo, type Recommendation,
  type SignalClass, type SnapshotPoint, type Strategy,
} from '../domain/types.ts';

export const SIGNAL_TAG: Record<SignalClass, string> = { MARKET_SIGNAL: 'MARKTSIGNAL', LIVE_OFFER: 'LIVE-ANGEBOT', SIMULATION: 'SIMULATION' };

/** Quellen, die automatisch abgefragt werden (Listing-Feeds) – für sie gilt die strengere Frische-Grenze in Minuten. */
export const isFeedSource = (source: string) => source.startsWith('api:') || source.startsWith('test:');

/** Prüft die Pflichtangaben eines konkreten Angebots. */
export function checkListing(buy: BuyBasis): { complete: boolean; missing: string[]; review: string[] } {
  const missing: string[] = [];
  if (!buy.seller) missing.push('Verkäufer');
  if (!buy.offerUrl) missing.push('Link zum Angebot');
  if (!buy.condition || buy.condition === 'MIX') missing.push('Zustand');
  if (!buy.language) missing.push('Sprache');
  if (isFeedSource(buy.source) && !buy.externalId) missing.push('Angebots-ID');
  return { complete: missing.length === 0, missing, review: buy.reviewReasons ?? [] };
}
import { median, round1, round2 } from '../util/num.ts';
import { breakEvenSellPrice, computeScenarios, maxBuyPrice, type ScenarioResults } from './profit.ts';
import { estimateResale, type ResaleEstimate } from './resale.ts';
import { evaluateRules, type RuleResult } from './rules.ts';
import { scoreOpportunity, type ScoreResult } from './score.ts';
import { guideMetrics, historyMetrics, type GuideMetrics, type HistoryMetrics } from './stats.ts';

export interface BuyBasis {
  price: number;
  /** Porto je Karte; null = aus den Porto-Einstellungen schätzen. */
  shipping: number | null;
  /** true = kein belegtes Angebot, nur ein Modellwert aus Marktstatistiken (Marktsignal). */
  hypothetical?: boolean;
  externalId?: string | null;   // Angebots-ID der Quelle (Listing-ID)
  reviewReasons?: string[];     // Gründe, warum das Angebot vor einem Kauf geprüft werden muss
  label: string;                // z. B. "Einzelangebot von X" / "Modellwert (hypothetisch): 1-Tages-Ø"
  observedAt: string;           // Zeitpunkt der Beobachtung bzw. Datenstand
  source: string;               // cardmarket_price_guide | extension | manual | simulation | api:*
  condition: string | null;
  language: string | null;
  offerId: number | null;
  offerUrl: string | null;
  seller: string | null;
  sellerCountry: string | null;
  sellerType: string | null;
  sellerSales: number | null;
  amount: number | null;
  previousPrice: number | null;
}

export interface OpportunityInput {
  product: ProductInfo;
  finish: Finish;
  guide: GuidePrices | null;
  history: SnapshotPoint[];
  strategy: Strategy;
  signalClass: SignalClass;
  buy: BuyBasis;
  triggers: string[];           // warum diese Strategie angeschlagen hat
  exposure: Exposure;           // Bestand, Bestellungen, Kapital (2.1)
  now: number;
  confidenceDelta?: number;
  confidenceNote?: string;
}

export interface Opportunity {
  key: string;
  productId: number;
  externalId: number;
  name: string;
  setName: string | null;
  setCode: string | null;
  collectorNumber: string | null;
  rarity: string | null;
  imageUrl: string | null;
  finish: Finish;
  signalClass: SignalClass;
  /** listing = belegtes Einzelangebot; market_model = Marktstatistik (keine Einkaufs-/Gewinnwerte anzeigen); simulation = Test. */
  evidence: Evidence;
  /** Kennzeichnung für Dashboard und Alarme: LIVE-ANGEBOT / MARKTSIGNAL / SIMULATION / VERALTET / TEST */
  labels: string[];
  stale: boolean;
  staleReason: string | null;
  /** Pflichtangaben eines Angebots (Verkäufer, Preis, Link, Zustand, Sprache, Angebots-ID) – fehlende → Prüfung statt Kauf. */
  listingCheck: { complete: boolean; missing: string[]; review: string[] };
  strategy: Strategy;
  strategyLabel: string;
  buy: BuyBasis & { shipping: number; shippingNote: string; effective: number; capital: number };
  marketPrice: number | null;
  referencePrice: number | null;
  discountPct: number | null;
  resale: ResaleEstimate;
  scenarios: ScenarioResults;
  breakEvenSellPrice: number | null;
  maxBuyPrice: number | null;
  guide: (GuidePrices & GuideMetrics) | null;
  history: HistoryMetrics;
  score: ScoreResult;
  rules: RuleResult;
  recommendation: Recommendation;
  priority: Priority | null;    // HIGH / MEDIUM / WATCH (null = nicht interessant oder Simulation)
  holdings: { copies: number; onOrder: number };
  reasons: string[];
  triggers: string[];
  dataDate: string | null;
  productUrl: string;
  computedAt: string;
}

export function productUrl(externalId: number): string {
  return `https://www.cardmarket.com/de/Magic/Products?idProduct=${externalId}`;
}

export function hoursBetween(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 36e5) : null;
}

export function buildOpportunity(inp: OpportunityInput, s: AppSettings): Opportunity {
  const { product, guide, buy } = inp;
  const isOffer = inp.signalClass !== 'MARKET_SIGNAL';
  const emptyGuide: GuidePrices = { avg: null, low: null, trend: null, avg1: null, avg7: null, avg30: null, sourceCreatedAt: '' };
  const g = guide ?? emptyGuide;
  const gm = guideMetrics(g);
  const hm = historyMetrics(inp.history, s.analysis.volatilityMinDays);

  // --- Einkauf ---
  let shipping: number, shippingNote: string;
  if (buy.shipping != null) {
    shipping = buy.shipping;
    shippingNote = 'angegeben';
  } else if (!isOffer && s.shipping.marketSignalAssumeDomestic) {
    const est = shippingCost(buy.price, s.shipping.homeCountry, s.shipping);
    shipping = est.cost;
    shippingNote = 'Annahme: Kauf im Inland' + (est.tracked ? ', versichert' : ', Brief') + ' (Einzelkauf)';
  } else {
    const est = shippingCost(buy.price, buy.sellerCountry, s.shipping);
    shipping = est.cost;
    shippingNote = (est.known ? (est.domestic ? 'Inland' : 'Ausland') : 'Land unbekannt → Ausland angenommen') +
      (est.tracked ? ', versichert' : ', Brief') + ' (Einzelkauf)';
  }
  const effective = round2(buy.price + shipping);
  const capital = round2(effective + s.fees.otherAcquisitionCost);

  // --- Wiederverkauf & Profit ---
  const resale = estimateResale(g, s.resale, buy.condition, buy.language);
  const scenarios = computeScenarios({ buyPrice: buy.price, buyShipping: shipping }, resale, s.fees, s.tax);
  const refs = resale.refs;
  const referencePrice = refs.length ? round2(median(refs) as number) : null;
  const adjustedRef = referencePrice == null ? null : referencePrice * resale.conditionFactor * resale.languageFactor;
  const discountPct = adjustedRef ? round1((adjustedRef - effective) / adjustedRef * 100) : null;
  const be = breakEvenSellPrice({ buyPrice: buy.price, buyShipping: shipping }, s.fees, s.tax);
  const mb = resale.base == null ? null : maxBuyPrice(resale.base, shipping, s.rules.minProfit, s.rules.minRoiPct, s.fees, s.tax);

  const now = inp.now;
  const guideAge = hoursBetween(g.sourceCreatedAt || null, now);
  const offerAge = isOffer ? hoursBetween(buy.observedAt, now) : null;
  const foil = inp.finish === 'foil';
  const country = buy.sellerCountry;
  const intl = country == null ? null : shippingCost(0, country, s.shipping).domestic === false;

  const score = scoreOpportunity({
    signalClass: inp.signalClass, strategy: inp.strategy,
    profitBase: scenarios.base?.profit ?? null, roiBase: scenarios.base?.roiPct ?? null,
    profitConservative: scenarios.conservative?.profit ?? null,
    discountPct, guide: gm,
    guideHasAvg1: g.avg1 != null, guideHasAvg7: g.avg7 != null, guideHasAvg30: g.avg30 != null,
    history: hm, guideAgeHours: guideAge, offerAgeHours: offerAge,
    mapped: product.mappingStatus === 'mapped',
    conditionKnown: buy.condition != null, condition: buy.condition, foil,
    sellerSales: buy.sellerSales, sellerType: buy.sellerType, international: intl, capital,
    confidenceDelta: inp.confidenceDelta, confidenceNote: inp.confidenceNote,
  }, s);

  const ex = inp.exposure;
  const vKey = `${product.id}:${inp.finish}`;
  const holdings = { copies: ex.copies.get(vKey) ?? 0, onOrder: ex.onOrder.get(vKey) ?? 0 };
  const rules = evaluateRules({
    referencePrice, profitBase: scenarios.base?.profit ?? null, profitConservative: scenarios.conservative?.profit ?? null,
    roiBase: scenarios.base?.roiPct ?? null, discountPct, capital, inventoryCapital: ex.investedTotal,
    confidence: score.confidence, condition: buy.condition, language: buy.language, foil,
    offerAgeHours: offerAge, isOffer,
    copiesHeld: holdings.copies, copiesOnOrder: holdings.onOrder, setName: product.setName,
    setInvested: product.setName ? ex.setInvested.get(product.setName) ?? 0 : 0,
    availableCapital: ex.availableCapital, slowSharePct: ex.slowSharePct,
  }, s);

  // --- Belegt oder Modell? Frisch oder veraltet? ---
  const evidence: Evidence = inp.signalClass === 'MARKET_SIGNAL' ? 'market_model' : inp.signalClass === 'SIMULATION' ? 'simulation' : 'listing';
  const listingCheck = evidence === 'market_model' ? { complete: false, missing: ['kein konkretes Angebot'], review: [] } : checkListing(buy);
  let staleReason: string | null = null;
  if (guideAge == null) staleReason = 'kein Price Guide';
  else if (guideAge > s.analysis.staleGuideHours) staleReason = `Price Guide ${Math.round(guideAge)} h alt`;
  if (isOffer && offerAge != null) {
    const feed = isFeedSource(buy.source);
    const limitH = feed ? s.live.maxListingAgeMinutes / 60 : s.rules.maxOfferAgeHours;
    if (offerAge > limitH) staleReason = `Angebot ${feed ? Math.round(offerAge * 60) + ' Min.' : Math.round(offerAge) + ' h'} alt (Grenze ${feed ? s.live.maxListingAgeMinutes + ' Min.' : limitH + ' h'})`;
  }
  const stale = staleReason != null;
  const cons = scenarios.conservative;
  const consOk = cons != null && cons.profit >= s.live.minConservativeProfit && (cons.roiPct ?? -Infinity) >= s.live.minConservativeRoiPct;

  // --- Empfehlung: KAUFEN nur für ein konkretes, vollständiges, frisches Angebot; ein Marktsignal ist NIE ein Kaufauftrag ---
  let recommendation: Recommendation = 'NICHT KAUFEN';
  if (inp.signalClass === 'LIVE_OFFER' && rules.passed) {
    recommendation = listingCheck.complete && !listingCheck.review.length && !stale && consOk ? 'KAUFEN' : 'PRÜFEN';
  } else if (inp.signalClass === 'MARKET_SIGNAL' && rules.passed) recommendation = 'PRÜFEN';

  const labels = [SIGNAL_TAG[inp.signalClass]];
  if (stale) labels.push('VERALTET');
  if (buy.source.startsWith('test:')) labels.push('TEST');

  // --- Business-Priorität (2.1) ---
  const a = s.alerts;
  let priority: Priority | null = null;
  if (inp.signalClass === 'LIVE_OFFER' && recommendation === 'KAUFEN') {
    const high = offerAge != null && offerAge <= a.highMaxOfferAgeHours && cons != null && cons.profit >= a.highMinConservativeProfit &&
      (cons.roiPct ?? 0) >= a.highMinConservativeRoiPct && score.confidence >= a.highMinConfidence;
    priority = high ? 'HIGH' : 'MEDIUM';
  } else if (inp.signalClass === 'MARKET_SIGNAL') {
    priority = rules.passed ? 'MEDIUM' : 'WATCH';
  }

  const reasons: string[] = [];
  if (holdings.copies + holdings.onOrder > 0) reasons.push(`Bereits ${holdings.copies} Exemplar(e) im Bestand${holdings.onOrder ? ` und ${holdings.onOrder} bestellt` : ''} (Grenze ${s.limits.maxCopiesPerCard}).`);
  if (inp.signalClass === 'SIMULATION') reasons.push(buy.source.startsWith('test:') ? 'SIMULATION (TEST-Feed) – erfundene Testdaten, keine Kaufmöglichkeit.' : 'SIMULATION – Testdaten, keine Kaufmöglichkeit.');
  if (inp.signalClass === 'MARKET_SIGNAL') reasons.push('Marktsignal (Recherche) aus aggregierten Cardmarket-Daten: kein konkretes Angebot, daher weder Einkaufspreis noch belegter Gewinn. Vor einem Kauf ein konkretes Angebot erfassen.');
  if (stale) reasons.push(`VERALTET: ${staleReason}.`);
  if (evidence !== 'market_model' && listingCheck.missing.length) reasons.push(`Pflichtangaben fehlen: ${listingCheck.missing.join(', ')} → nur Prüfung, keine Kaufchance.`);
  if (listingCheck.review.length) reasons.push(`Vor Kauf prüfen: ${listingCheck.review.join(', ')}.`);
  if (inp.signalClass === 'LIVE_OFFER' && rules.passed && !consOk) reasons.push(`Konservatives Szenario unter der Mindestschwelle (${s.live.minConservativeProfit.toFixed(2)} € / ${s.live.minConservativeRoiPct} % ROI).`);
  reasons.push(...inp.triggers);
  const b = scenarios.base;
  if (b && evidence === 'market_model') reasons.push(`Hypothetisches Modell: Bei einem Kauf zum Modellwert ${buy.price.toFixed(2)} € ergäbe sich rechnerisch ${b.profit.toFixed(2)} € – kein Angebot zu diesem Preis belegt.`);
  else if (b) reasons.push(`Basisszenario: Verkauf ${b.sellPrice.toFixed(2)} € → Ertrag ${b.profit.toFixed(2)} € (ROI ${b.roiPct ?? '–'} %).`);
  if (rules.smallProfitMode) reasons.push('Small-Profit-Modus: kleiner Ertrag bei geringer Kapitalbindung.');
  if (score.capped) reasons.push(`Score gedeckelt (max. ${s.analysis.lowConfidenceScoreCap}), weil Confidence ${score.confidence} < ${s.rules.minConfidence}.`);
  reasons.push(...score.confidenceNotes.map(n => n[0].toUpperCase() + n.slice(1) + '.'));
  if (!rules.passed) reasons.push('Nicht erfüllt: ' + rules.failures.slice(0, 3).join('; ') + (rules.failures.length > 3 ? ' …' : ''));
  reasons.push(...resale.notes);

  const keyParts = [inp.strategy, product.id, inp.finish];
  if (buy.offerId != null) keyParts.push(buy.offerId);

  return {
    key: keyParts.join(':'),
    productId: product.id, externalId: product.externalId, name: product.name,
    setName: product.setName, setCode: product.setCode, collectorNumber: product.collectorNumber,
    rarity: product.rarity, imageUrl: product.imageUrl, finish: inp.finish,
    signalClass: inp.signalClass, evidence, labels, stale, staleReason, listingCheck,
    strategy: inp.strategy, strategyLabel: STRATEGY_LABELS[inp.strategy],
    buy: { ...buy, shipping: round2(shipping), shippingNote, effective, capital },
    marketPrice: g.trend, referencePrice, discountPct,
    resale, scenarios, breakEvenSellPrice: be, maxBuyPrice: mb,
    guide: guide ? { ...guide, ...gm } : null,
    history: hm, score, rules, recommendation, priority, holdings, reasons, triggers: inp.triggers,
    dataDate: g.sourceCreatedAt || null,
    productUrl: productUrl(product.externalId),
    computedAt: new Date(now).toISOString(),
  };
}
