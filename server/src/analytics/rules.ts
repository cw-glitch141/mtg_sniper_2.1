/**
 * Konfigurierbare Buy-Rules. Liefert für jede Regel ein nachvollziehbares Ergebnis.
 * Ein kleiner Deal (Small-Profit-Modus) kann die Mindestgewinn-Regel ersetzen, wenn
 * Kapitalbindung gering und ROI hoch genug ist.
 */
import type { AppSettings } from '../domain/settings.ts';
import { CONDITIONS, type Condition } from '../domain/types.ts';

/** Bestands- und Kapitalsituation zum Zeitpunkt der Bewertung (2.1). */
export interface Exposure {
  investedTotal: number;                 // Einstand Lager + unterwegs + reservierte Einkäufe
  availableCapital: number | null;       // null = kein Handelskapital erfasst → Regel inaktiv
  slowSharePct: number;
  copies: Map<string, number>;           // "<productId>:<finish>" → Exemplare im Geschäftsbestand
  onOrder: Map<string, number>;          // "<productId>:<finish>" → bestellt, noch nicht eingelagert
  setInvested: Map<string, number>;      // Editionsname → Einstand (inkl. bestellt)
}

export const EMPTY_EXPOSURE: Exposure = { investedTotal: 0, availableCapital: null, slowSharePct: 0, copies: new Map(), onOrder: new Map(), setInvested: new Map() };

export interface RuleCheck { rule: string; ok: boolean; detail: string }
export interface RuleResult { passed: boolean; smallProfitMode: boolean; checks: RuleCheck[]; failures: string[] }

export interface RuleInput {
  referencePrice: number | null;
  profitBase: number | null;
  profitConservative: number | null;
  roiBase: number | null;
  discountPct: number | null;
  capital: number;
  inventoryCapital: number;
  confidence: number;
  // nur bei Einzelangeboten bekannt:
  condition: string | null;
  language: string | null;
  foil: boolean;
  offerAgeHours: number | null;
  isOffer: boolean;
  // Portfolio-Grenzen (2.1)
  copiesHeld?: number;
  copiesOnOrder?: number;
  setName?: string | null;
  setInvested?: number;
  availableCapital?: number | null;
  slowSharePct?: number;
}

const eur = (v: number | null) => (v == null ? '–' : v.toFixed(2) + ' €');
const pct = (v: number | null) => (v == null ? '–' : v.toFixed(1) + ' %');

export function evaluateRules(i: RuleInput, s: AppSettings): RuleResult {
  const r = s.rules;
  const checks: RuleCheck[] = [];
  const add = (rule: string, ok: boolean, detail: string) => checks.push({ rule, ok, detail });

  add('Preisniveau', i.referencePrice != null && i.referencePrice >= r.minPrice && i.referencePrice <= r.maxPrice,
    `Referenz ${eur(i.referencePrice)} (erlaubt ${r.minPrice}–${r.maxPrice} €)`);

  const normalProfit = i.profitBase != null && i.profitBase >= r.minProfit && i.roiBase != null && i.roiBase >= r.minRoiPct;
  const sp = r.smallProfit;
  const smallProfit = !normalProfit && sp.enabled && i.profitBase != null && i.profitBase >= sp.minProfit &&
    i.capital <= sp.maxCapital && i.roiBase != null && i.roiBase >= sp.minRoiPct;
  add('Mindestgewinn & ROI', normalProfit || smallProfit,
    smallProfit
      ? `Small-Profit-Modus: ${eur(i.profitBase)} ≥ ${sp.minProfit} €, ROI ${pct(i.roiBase)} ≥ ${sp.minRoiPct} %, Kapital ${eur(i.capital)} ≤ ${sp.maxCapital} €`
      : `Gewinn ${eur(i.profitBase)} (min. ${r.minProfit} €), ROI ${pct(i.roiBase)} (min. ${r.minRoiPct} %)`);

  add('Mindest-Rabatt', i.discountPct != null && i.discountPct >= r.minDiscountPct, `${pct(i.discountPct)} (min. ${r.minDiscountPct} %)`);
  if (r.requireNonNegativeConservative) {
    add('Konservatives Szenario', i.profitConservative != null && i.profitConservative >= 0, `Gewinn konservativ ${eur(i.profitConservative)}`);
  }
  add('Kapital je Karte', i.capital <= r.maxCapitalPerCard, `${eur(i.capital)} (max. ${r.maxCapitalPerCard} €)`);
  add('Gesamtbestand', i.inventoryCapital + i.capital <= r.maxInventoryCapital,
    `gebunden ${eur(i.inventoryCapital)} + ${eur(i.capital)} (max. ${r.maxInventoryCapital} €)`);
  add('Datenqualität', i.confidence >= r.minConfidence, `Confidence ${i.confidence} (min. ${r.minConfidence})`);

  // --- Portfolio-Grenzen: keine unkontrollierten Nachkäufe ---
  const L = s.limits;
  const held = (i.copiesHeld ?? 0) + (i.copiesOnOrder ?? 0);
  add('Exemplare dieser Karte', held + 1 <= L.maxCopiesPerCard,
    `${i.copiesHeld ?? 0} im Bestand + ${i.copiesOnOrder ?? 0} bestellt + 1 (max. ${L.maxCopiesPerCard})`);
  if (i.setName) {
    add('Editionslimit', (i.setInvested ?? 0) + i.capital <= L.maxInvestmentPerSet,
      `${i.setName}: ${eur(i.setInvested ?? 0)} + ${eur(i.capital)} (max. ${L.maxInvestmentPerSet} €)`);
  }
  if (i.availableCapital === null || i.availableCapital === undefined) {
    add('Verfügbares Kapital', true, 'kein Handelskapital erfasst – Regel inaktiv');
  } else {
    add('Verfügbares Kapital', i.capital <= i.availableCapital, `${eur(i.capital)} benötigt, verfügbar ${eur(i.availableCapital)} (nach Reserve ${L.minLiquidityReserve} €)`);
  }
  add('Langsamdreher-Anteil', (i.slowSharePct ?? 0) <= L.maxSlowMoverSharePct, `${pct(i.slowSharePct ?? 0)} des Bestandswerts (max. ${L.maxSlowMoverSharePct} %)`);

  if (i.isOffer) {
    const worst = CONDITIONS.indexOf(r.worstCondition as Condition);
    const idx = i.condition ? CONDITIONS.indexOf(i.condition as Condition) : -1;
    add('Zustand', idx !== -1 && (worst === -1 || idx <= worst), `${i.condition ?? 'unbekannt'} (schlechtestens ${r.worstCondition})`);
    add('Sprache', i.language != null && r.allowedLanguages.includes(i.language), `${i.language ?? 'unbekannt'} (erlaubt: ${r.allowedLanguages.join(', ')})`);
    add('Foil', r.includeFoil || !i.foil, i.foil ? 'Foil' : 'Nonfoil');
    add('Angebotsalter', i.offerAgeHours != null && i.offerAgeHours <= r.maxOfferAgeHours,
      `${i.offerAgeHours == null ? '?' : Math.round(i.offerAgeHours)} h (max. ${r.maxOfferAgeHours} h)`);
  } else if (!r.includeFoil && i.foil) {
    add('Foil', false, 'Foil ausgeschlossen');
  }

  const failures = checks.filter(c => !c.ok).map(c => `${c.rule}: ${c.detail}`);
  return { passed: failures.length === 0, smallProfitMode: smallProfit, checks, failures };
}
