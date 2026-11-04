/**
 * Profit-Engine: transparente Kalkulation eines Handels (Einkauf → Wiederverkauf).
 *
 * Konventionen
 *   - Alle Beträge in Euro je Karte.
 *   - buyPrice / sellPrice sind Bruttobeträge (das, was tatsächlich gezahlt bzw. vom Käufer verlangt wird).
 *   - Der Versand, den der Käufer zahlt, gleicht das Porto aus; nur der ungedeckte Rest
 *     (fees.uncoveredShippingCost) und die Verpackung sind Kosten.
 *   - Gewinn = vor Ertragsteuern. Einkommen-/Gewerbesteuer werden NICHT berechnet.
 *
 * Umsatzsteuer (tax.mode)
 *   private          Privatverkauf: keine Umsatzsteuer. Nur für echte Privatverkäufe zulässig.
 *   kleinunternehmer §19 UStG: keine Umsatzsteuer, kein Vorsteuerabzug → alle Kosten brutto.
 *   regular          Regelbesteuerung: USt ist aus dem Verkaufspreis herauszurechnen. Vorsteuer auf
 *                    Gebühren/Verpackung abziehbar; auf den Einkauf nur mit ausgewiesener USt
 *                    (tax.purchaseVatDeductible). Porto (Briefe der Deutschen Post) gilt als umsatzsteuerfrei.
 *   margin           Differenzbesteuerung (§25a UStG): USt nur auf die Marge (Verkauf − Einkauf),
 *                    zulässig nur bei Einkauf ohne Vorsteuerabzug (z. B. von Privatpersonen).
 * Dies ist eine Rechenhilfe, keine Steuerberatung.
 */
import type { AppSettings } from '../domain/settings.ts';
import { round2 } from '../util/num.ts';

export interface TradeInput {
  buyPrice: number;
  buyShipping: number;         // anteiliges Einkaufsporto je Karte
  otherAcquisition?: number;   // überschreibt fees.otherAcquisitionCost
  sellPrice: number;
}

export interface CostLine { key: string; label: string; amount: number; note?: string }

export interface TradeResult {
  sellPrice: number;
  capital: number;             // gebundenes Kapital (Brutto-Auszahlung beim Einkauf)
  outputVat: number;
  netRevenue: number;
  lines: CostLine[];           // Erlöse positiv, Kosten negativ – summiert ergibt das den Gewinn
  totalCosts: number;
  profit: number;
  roiPct: number | null;
  marginPct: number | null;
  warnings: string[];
}

type Fees = AppSettings['fees'];
type Tax = AppSettings['tax'];

export function computeTrade(input: TradeInput, fees: Fees, tax: Tax): TradeResult {
  const warnings: string[] = [];
  const v = tax.vatRatePct / 100;
  const vatShare = v / (1 + v);
  const deductible = tax.mode === 'regular' || tax.mode === 'margin';
  const net = (gross: number) => (deductible ? gross / (1 + v) : gross);

  const other = input.otherAcquisition ?? fees.otherAcquisitionCost;
  const capital = input.buyPrice + input.buyShipping + other;

  // --- Umsatzsteuer auf den Verkauf ---
  let outputVat = 0;
  if (tax.mode === 'regular') {
    outputVat = input.sellPrice * vatShare;
  } else if (tax.mode === 'margin') {
    if (tax.purchaseVatDeductible) warnings.push('Differenzbesteuerung ist bei Einkauf mit Vorsteuerabzug nicht zulässig.');
    outputVat = Math.max(0, input.sellPrice - input.buyPrice) * vatShare;
  }
  const netRevenue = input.sellPrice - outputVat;

  // --- Einkauf ---
  let acquisition = capital;
  let acquisitionNote = 'Kaufpreis + anteiliges Porto + sonstige Beschaffungskosten';
  if (tax.mode === 'regular' && tax.purchaseVatDeductible) {
    acquisition = (input.buyPrice + input.buyShipping) / (1 + v) + other;
    acquisitionNote += ' (netto, Vorsteuer abziehbar)';
  }

  const commission = net(input.sellPrice * fees.commissionPct / 100);
  const payment = net(input.sellPrice * fees.paymentFeePct / 100 + fees.paymentFeeFixed);
  const packaging = net(fees.packagingCost);
  const uncoveredShipping = fees.uncoveredShippingCost;
  const returnLoss = input.sellPrice * fees.returnLossPct / 100;
  const labor = fees.laborMinutes / 60 * fees.hourlyRate;

  const lines: CostLine[] = [
    { key: 'sell', label: 'Verkaufspreis (brutto)', amount: input.sellPrice },
  ];
  if (outputVat > 0) lines.push({ key: 'vat', label: 'Umsatzsteuer', amount: -outputVat, note: tax.mode === 'margin' ? 'nur auf die Marge (§25a)' : `${tax.vatRatePct} % im Preis enthalten` });
  lines.push(
    { key: 'acquisition', label: 'Einkauf gesamt', amount: -acquisition, note: acquisitionNote },
    { key: 'commission', label: 'Verkaufsprovision', amount: -commission, note: `${fees.commissionPct} % vom Verkaufspreis` + (deductible ? ', netto' : '') },
  );
  if (payment > 0) lines.push({ key: 'payment', label: 'Zahlungs-/Transaktionskosten', amount: -payment });
  lines.push(
    { key: 'packaging', label: 'Verpackung', amount: -packaging },
    { key: 'shipping', label: 'Ungedecktes Porto', amount: -uncoveredShipping },
    { key: 'returns', label: 'Retouren-/Verlustrisiko', amount: -returnLoss, note: `${fees.returnLossPct} % Erwartungswert` },
    { key: 'labor', label: 'Kalkulatorische Arbeitszeit', amount: -labor, note: `${fees.laborMinutes} min × ${fees.hourlyRate} €/h` },
  );

  const totalCosts = acquisition + commission + payment + packaging + uncoveredShipping + returnLoss + labor;
  const profit = netRevenue - totalCosts;
  for (const l of lines) l.amount = round2(l.amount);

  return {
    sellPrice: round2(input.sellPrice),
    capital: round2(capital),
    outputVat: round2(outputVat),
    netRevenue: round2(netRevenue),
    lines,
    totalCosts: round2(totalCosts),
    profit: round2(profit),
    roiPct: capital > 0 ? round2(profit / capital * 100) : null,
    marginPct: input.sellPrice > 0 ? round2(profit / input.sellPrice * 100) : null,
    warnings,
  };
}

/** Bisektion für monotone Funktionen. Liefert das kleinste x in [lo, hi] mit pred(x) === true. */
function bisect(lo: number, hi: number, pred: (x: number) => boolean): number | null {
  if (!pred(hi)) return null;
  if (pred(lo)) return lo;
  for (let i = 0; i < 60 && hi - lo > 0.0005; i++) {
    const mid = (lo + hi) / 2;
    if (pred(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

/** Verkaufspreis, ab dem der Gewinn ≥ 0 ist (auf den Cent aufgerundet). */
export function breakEvenSellPrice(input: Omit<TradeInput, 'sellPrice'>, fees: Fees, tax: Tax): number | null {
  const hi = Math.max(100, (input.buyPrice + input.buyShipping) * 10 + 50);
  const x = bisect(0, hi, s => computeTrade({ ...input, sellPrice: s }, fees, tax).profit >= 0);
  return x == null ? null : Math.ceil(x * 100 - 1e-6) / 100;
}

/**
 * Höchster Einkaufspreis, bei dem Mindestgewinn UND Ziel-ROI im gewählten Verkaufsszenario
 * noch erreicht werden (auf den Cent abgerundet). null, wenn selbst ein Einkauf zu 0 € nicht reicht.
 */
export function maxBuyPrice(
  sellPrice: number, buyShipping: number, minProfit: number, minRoiPct: number, fees: Fees, tax: Tax,
): number | null {
  const ok = (b: number) => {
    const r = computeTrade({ buyPrice: b, buyShipping, sellPrice }, fees, tax);
    return r.profit >= minProfit && (r.roiPct == null || r.roiPct >= minRoiPct);
  };
  if (!ok(0)) return null;
  // "erfüllt" ist monoton fallend im Einkaufspreis → kleinstes b suchen, das NICHT mehr erfüllt.
  const firstFail = bisect(0, sellPrice * 2 + 10, b => !ok(b));
  if (firstFail == null) return round2(sellPrice * 2 + 10);
  return Math.floor(firstFail * 100 - 1e-6) / 100;
}

export interface Scenario { conservative: number | null; base: number | null; optimistic: number | null }
export interface ScenarioResults { conservative: TradeResult | null; base: TradeResult | null; optimistic: TradeResult | null }

export function computeScenarios(
  buy: Omit<TradeInput, 'sellPrice'>, resale: Scenario, fees: Fees, tax: Tax,
): ScenarioResults {
  const calc = (s: number | null) => (s == null ? null : computeTrade({ ...buy, sellPrice: s }, fees, tax));
  return { conservative: calc(resale.conservative), base: calc(resale.base), optimistic: calc(resale.optimistic) };
}
