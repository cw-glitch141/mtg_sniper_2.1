/**
 * Händler-Buchhaltung (rein rechnerisch, ohne Datenbank) – Grundlage für Journal, Analytics und Repricing.
 *
 * Begriffe
 *   Umsatz (brutto)      Artikelpreise + vom Käufer bezahltes Porto
 *   Nettoerlös           Umsatz − Umsatzsteuer
 *   Wareneinsatz         Einstand der verkauften Exemplare (Kaufpreis + zugeordnete Einkaufsnebenkosten),
 *                        abzüglich abziehbarer Vorsteuer
 *   Deckungsbeitrag (DB) Nettoerlös − Wareneinsatz − Plattform-/Zahlungsgebühren − Porto − Verpackung − sonstige Kosten
 *   Arbeitszeit          kalkulatorisch, getrennt ausgewiesen (keine Ausgabe)
 *   USt-Zahllast         Umsatzsteuer − abziehbare Vorsteuer (Schätzung)
 *
 * Steuerliche Behandlung je verkauftem Exemplar (nicht pauschal):
 *   Modus kleinunternehmer/private → keine USt, keine Vorsteuer.
 *   Modus regular → USt auf Umsatz; Vorsteuer auf Einkauf nur bei Charge mit Rechnung ("vat_invoice"),
 *                    auf Gebühren und Verpackung immer; Porto (Briefe) ohne USt.
 *   Modus margin  → je Exemplar: Charge "vat_invoice" → regulär; sonst Differenzbesteuerung (§25a) auf
 *                    (Verkaufspreis inkl. anteiligem Porto − Kaufpreis), nie negativ.
 * Vereinfachte Rechenhilfe, keine Steuerberatung.
 */
import type { AppSettings, TaxMode } from '../domain/settings.ts';
import { round2 } from '../util/num.ts';

/** Verteilt `total` (Cent-genau) proportional auf `weights`; Rundungsreste nach größtem Rest. */
export function allocateCents(total: number, weights: number[]): number[] {
  const cents = Math.round(total * 100);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (sum <= 0) {
    const base = Math.floor(cents / weights.length);
    return weights.map((_, i) => (base + (i < cents - base * weights.length ? 1 : 0)) / 100);
  }
  const raw = weights.map(w => (cents * w) / sum);
  const floor = raw.map(Math.floor);
  let rest = cents - floor.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const o of order) { if (rest <= 0) break; floor[o.i]++; rest--; }
  return floor.map(c => c / 100);
}

export type VatTreatment = 'none' | 'vat_invoice' | 'margin_scheme';

export interface SoldUnitGroup {
  qty: number;              // versendete Exemplare (Umsatzbasis; Erstattungen stehen in OrderCosts.refund)
  costQty?: number;         // Exemplare mit Wareneinsatz (= qty − wieder eingelagerte Rücksendungen)
  unitPrice: number;        // Verkaufspreis je Stück (brutto)
  unitCost: number;         // Kaufpreis je Stück (brutto, wie bezahlt)
  unitAlloc: number;        // zugeordnete Einkaufsnebenkosten je Stück
  treatment: VatTreatment;
  vatRatePct: number;       // Satz der Einkaufsrechnung
}

export interface OrderCosts {
  shippingCharged: number;  // vom Käufer bezahltes Porto (einmal je Auftrag)
  shippingCost: number;     // tatsächliches Porto (einmal je Auftrag)
  packagingCost: number;
  platformFee: number;
  paymentFee: number;
  otherCosts: number;
  refund: number;           // erstattete Beträge (z. B. Teilrückgabe)
}

export interface OrderResult {
  units: number;
  revenueGross: number;
  outputVat: number;
  netRevenue: number;
  cogs: number;             // Wareneinsatz (netto, falls Vorsteuer abziehbar)
  inputVat: number;         // abziehbare Vorsteuer (Einkauf + Gebühren + Verpackung)
  fees: number;             // Plattform + Zahlung (netto bei Vorsteuerabzug)
  shipping: number;
  packaging: number;
  other: number;
  refund: number;
  contribution: number;     // Deckungsbeitrag
  vatLiability: number;     // Umsatzsteuer − Vorsteuer
  laborMinutes: number;
  laborCost: number;
  profitAfterLabor: number;
  lines: { revenue: number; cogs: number; contribution: number }[];
}

export function orderResult(groups: SoldUnitGroup[], c: OrderCosts, s: Pick<AppSettings, 'tax' | 'business' | 'fees'>): OrderResult {
  const mode: TaxMode = s.tax.mode;
  const v = s.tax.vatRatePct / 100;
  const share = v / (1 + v);
  const deductible = mode === 'regular' || mode === 'margin';
  const units = groups.reduce((a, g) => a + g.qty, 0);
  const itemRevenue = groups.map(g => g.unitPrice * g.qty);
  // Käuferporto und Erstattungen anteilig nach Artikelwert auf die Positionen verteilen (nur einmal je Auftrag)
  const shipShare = allocateCents(c.shippingCharged, itemRevenue);
  const refundShare = allocateCents(c.refund, itemRevenue);

  let outputVat = 0, cogs = 0, inputVatGoods = 0;
  const lineData = groups.map((g, i) => {
    const revenue = itemRevenue[i] + shipShare[i] - refundShare[i];
    const costQty = g.costQty ?? g.qty;
    const purchase = g.unitCost * costQty;
    const alloc = g.unitAlloc * costQty;
    let lineVat = 0, lineInput = 0;
    if (mode === 'regular' || (mode === 'margin' && g.treatment === 'vat_invoice')) {
      lineVat = revenue * share;
      if (g.treatment === 'vat_invoice') lineInput = (purchase + alloc) * (g.vatRatePct / 100) / (1 + g.vatRatePct / 100);
    } else if (mode === 'margin') {
      lineVat = Math.max(0, revenue - purchase) * share;
    }
    outputVat += lineVat;
    inputVatGoods += lineInput;
    const lineCogs = purchase + alloc - lineInput;
    cogs += lineCogs;
    return { revenue, vat: lineVat, cogs: lineCogs };
  });

  const revenueGross = itemRevenue.reduce((a, b) => a + b, 0) + c.shippingCharged - c.refund;
  const feesGross = c.platformFee + c.paymentFee;
  const fees = deductible ? feesGross / (1 + v) : feesGross;
  const packaging = deductible ? c.packagingCost / (1 + v) : c.packagingCost;
  const other = c.otherCosts;
  const inputVat = inputVatGoods + (deductible ? feesGross - fees + c.packagingCost - packaging : 0);
  const netRevenue = revenueGross - outputVat;
  const contribution = netRevenue - cogs - fees - c.shippingCost - packaging - other;
  const laborMinutes = units > 0 ? s.business.laborMinutesPerOrder + units * s.business.laborMinutesPerCard : 0;
  const laborCost = laborMinutes / 60 * s.fees.hourlyRate;

  // Verkaufskosten anteilig auf Positionen (für Auswertungen je Karte/Strategie)
  const varCosts = fees + c.shippingCost + packaging + other;
  const costShare = allocateCents(varCosts, itemRevenue);
  const lines = lineData.map((l, i) => ({
    revenue: round2(l.revenue), cogs: round2(l.cogs), contribution: round2(l.revenue - l.vat - l.cogs - costShare[i]),
  }));

  return {
    units, revenueGross: round2(revenueGross), outputVat: round2(outputVat), netRevenue: round2(netRevenue), cogs: round2(cogs),
    inputVat: round2(inputVat), fees: round2(fees), shipping: round2(c.shippingCost), packaging: round2(packaging), other: round2(other),
    refund: round2(c.refund), contribution: round2(contribution), vatLiability: round2(outputVat - inputVat),
    laborMinutes: round2(laborMinutes), laborCost: round2(laborCost), profitAfterLabor: round2(contribution - laborCost), lines,
  };
}

/**
 * Mindestverkaufspreis je Stück für eine Charge: kleinster Preis, bei dem der Verkauf eines einzelnen Exemplars
 * (als eigener Auftrag, Porto vom Käufer gedeckt bis auf `uncoveredShippingCost`) mindestens `targetProfit`
 * Deckungsbeitrag und `targetMarginPct` Marge bringt. targetProfit = 0 → Verlustgrenze (Break-even).
 */
export function minSellPrice(
  unitCost: number, unitAlloc: number, treatment: VatTreatment, vatRatePct: number,
  s: Pick<AppSettings, 'tax' | 'business' | 'fees'>, targetProfit = 0, targetMarginPct = 0,
): number {
  const ok = (p: number) => {
    const r = orderResult([{ qty: 1, unitPrice: p, unitCost, unitAlloc, treatment, vatRatePct }], {
      shippingCharged: 0, shippingCost: s.fees.uncoveredShippingCost, packagingCost: s.fees.packagingCost,
      platformFee: p * s.fees.commissionPct / 100, paymentFee: p * s.fees.paymentFeePct / 100 + s.fees.paymentFeeFixed, otherCosts: 0, refund: 0,
    }, s);
    return r.contribution >= targetProfit - 1e-9 && (p <= 0 ? targetMarginPct <= 0 : r.contribution / p * 100 >= targetMarginPct - 1e-9);
  };
  let lo = 0, hi = Math.max(10, (unitCost + unitAlloc) * 4 + targetProfit * 4 + 10);
  for (let i = 0; i < 20 && !ok(hi); i++) hi *= 2;
  if (!ok(hi)) return Infinity; // Ziel-Marge unerreichbar (z. B. ≥ 100 %)
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return Math.ceil(hi * 100 - 1e-6) / 100;
}
