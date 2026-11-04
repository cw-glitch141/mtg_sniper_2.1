import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { breakEvenSellPrice, computeScenarios, computeTrade, maxBuyPrice } from '../src/analytics/profit.ts';
import { settings } from './helpers.ts';

// Standardgebühren: Provision 5 %, Verpackung 0,35 €, ungedecktes Porto 0,20 €, Retouren 2 %, Arbeit 5 min × 12 €/h = 1,00 €.
const s = settings();
const buy = { buyPrice: 20, buyShipping: 1.25 };

describe('Profit-Engine', () => {
  it('Kleinunternehmer: alle Kosten brutto, keine Umsatzsteuer (handgerechnet)', () => {
    const r = computeTrade({ ...buy, sellPrice: 30 }, s.fees, { ...s.tax, mode: 'kleinunternehmer' });
    // 30 − 21,25 − 1,50 − 0,35 − 0,20 − 0,60 − 1,00 = 5,10
    assert.equal(r.capital, 21.25);
    assert.equal(r.outputVat, 0);
    assert.equal(r.profit, 5.1);
    assert.equal(r.roiPct, 24);
    assert.equal(r.marginPct, 17);
    // Zeilen summieren sich zum Gewinn (Nachvollziehbarkeit)
    const sum = r.lines.reduce((a, l) => a + l.amount, 0);
    assert.ok(Math.abs(sum - r.profit) < 0.02, `Summe der Zeilen ${sum} ≠ Gewinn ${r.profit}`);
  });

  it('Regelbesteuerung: USt aus Verkaufspreis, Vorsteuer auf Gebühren/Verpackung, Porto steuerfrei', () => {
    const r = computeTrade({ ...buy, sellPrice: 30 }, s.fees, { ...s.tax, mode: 'regular', purchaseVatDeductible: false });
    // 30/1,19 = 25,2101; Provision 1,50/1,19 = 1,2605; Verpackung 0,35/1,19 = 0,2941
    // 25,2101 − 21,25 − 1,2605 − 0,2941 − 0,20 − 0,60 − 1,00 = 0,6055
    assert.equal(r.outputVat, 4.79);
    assert.equal(r.profit, 0.61);
  });

  it('Regelbesteuerung mit Vorsteuerabzug auf den Einkauf', () => {
    const r = computeTrade({ ...buy, sellPrice: 30 }, s.fees, { ...s.tax, mode: 'regular', purchaseVatDeductible: true });
    // Einkauf netto (20 + 1,25)/1,19 = 17,8571 → Gewinn = 25,2101 − 17,8571 − 1,2605 − 0,2941 − 0,2 − 0,6 − 1 = 3,9984
    assert.equal(r.profit, 4);
  });

  it('Differenzbesteuerung: USt nur auf die Marge', () => {
    const r = computeTrade({ ...buy, sellPrice: 30 }, s.fees, { ...s.tax, mode: 'margin' });
    // USt = (30 − 20) × 19/119 = 1,5966 → 28,4034 − 21,25 − 1,2605 − 0,2941 − 0,2 − 0,6 − 1 = 3,7987
    assert.equal(r.outputVat, 1.6);
    assert.equal(r.profit, 3.8);
    assert.deepEqual(r.warnings, []);
  });

  it('Differenzbesteuerung mit Vorsteuerabzug erzeugt eine Warnung', () => {
    const r = computeTrade({ ...buy, sellPrice: 30 }, s.fees, { ...s.tax, mode: 'margin', purchaseVatDeductible: true });
    assert.equal(r.warnings.length, 1);
  });

  it('Differenzbesteuerung: keine negative USt bei Verlustverkauf', () => {
    const r = computeTrade({ ...buy, sellPrice: 15 }, s.fees, { ...s.tax, mode: 'margin' });
    assert.equal(r.outputVat, 0);
  });

  it('Break-even-Verkaufspreis (Kleinunternehmer): 0,93·s = 22,80 → 24,52 €', () => {
    const be = breakEvenSellPrice(buy, s.fees, { ...s.tax, mode: 'kleinunternehmer' }) as number;
    assert.equal(be, 24.52);
    assert.ok(computeTrade({ ...buy, sellPrice: be }, s.fees, s.tax).profit >= 0);
    assert.ok(computeTrade({ ...buy, sellPrice: be - 0.02 }, s.fees, s.tax).profit < 0);
  });

  it('Maximaler Einkaufspreis: Mindestgewinn 5 € ist hier die bindende Grenze (20,10 €)', () => {
    // Gewinn(b) = 25,10 − b ≥ 5 → b ≤ 20,10; ROI-Grenze 15 % läge erst bei 21,66 €
    assert.equal(maxBuyPrice(30, 1.25, 5, 15, s.fees, s.tax), 20.1);
    // Strengerer ROI → ROI wird bindend: (25,10 − b) ≥ 0,4·(b + 1,25) → b ≤ 17,57
    assert.equal(maxBuyPrice(30, 1.25, 5, 40, s.fees, s.tax), 17.57);
  });

  it('Maximaler Einkaufspreis ist null, wenn selbst 0 € nicht reicht', () => {
    assert.equal(maxBuyPrice(3, 1.25, 5, 15, s.fees, s.tax), null);
  });

  it('Szenarien: fehlender Verkaufspreis ergibt null statt eines Ersatzwerts', () => {
    const r = computeScenarios(buy, { conservative: null, base: 30, optimistic: 35 }, s.fees, s.tax);
    assert.equal(r.conservative, null);
    assert.equal(r.base?.profit, 5.1);
    assert.ok((r.optimistic?.profit ?? 0) > (r.base?.profit ?? 0));
  });

  it('Gebühren sind konfigurierbar (z. B. Provision 0 %, keine Arbeitszeit)', () => {
    const fees = { ...s.fees, commissionPct: 0, laborMinutes: 0 };
    const r = computeTrade({ ...buy, sellPrice: 30 }, fees, s.tax);
    assert.equal(r.profit, 7.6); // 30 − 21,25 − 0,35 − 0,2 − 0,6
  });
});
