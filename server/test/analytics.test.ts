import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildOpportunity } from '../src/analytics/opportunity.ts';
import { estimateResale } from '../src/analytics/resale.ts';
import { EMPTY_EXPOSURE, evaluateRules, type RuleInput } from '../src/analytics/rules.ts';
import { changePct, guideMetrics, historyMetrics, implausible, movingAverage, reversalSignal, volatility } from '../src/analytics/stats.ts';
import { priceDip, spreadLow, volatilityScan } from '../src/analytics/strategies.ts';
import type { SnapshotPoint } from '../src/domain/types.ts';
import { guide, settings } from './helpers.ts';

function series(values: number[], start = '2026-10-01'): SnapshotPoint[] {
  const t0 = Date.parse(start + 'T00:00:00Z');
  return values.map((v, i) => ({ date: new Date(t0 + i * 864e5).toISOString().slice(0, 10), trend: v, avg1: v, avg7: v, avg30: v, low: v * 0.8 }));
}

describe('Statistik', () => {
  it('Veränderungen brauchen echte Historie – sonst null mit Hinweis', () => {
    const one = series([10]);
    const m = changePct(one, 'trend', 7);
    assert.equal(m.value, null);
    assert.match(m.note ?? '', /Historie/);
    const s = series([10, 10, 10, 10, 10, 10, 10, 12]);
    assert.equal(changePct(s, 'trend', 7).value, 20);
    assert.equal(changePct(s, 'trend', 1).value, 20);
  });

  it('Lücken in der Historie werden nicht überbrückt', () => {
    const s: SnapshotPoint[] = [
      { date: '2026-10-01', trend: 10, avg1: null, avg7: null, avg30: null, low: null },
      { date: '2026-10-20', trend: 12, avg1: null, avg7: null, avg30: null, low: null },
    ];
    assert.equal(changePct(s, 'trend', 7).value, null);
  });

  it('Gleitender Durchschnitt erst ab 70 % Abdeckung', () => {
    assert.equal(movingAverage(series([1, 2, 3]), 'trend', 7).value, null);
    assert.equal(movingAverage(series([1, 2, 3, 4, 5, 6, 7]), 'trend', 7).value, 4);
  });

  it('Volatilität braucht Mindestanzahl Tage', () => {
    assert.equal(volatility(series([10, 11, 10]), 'trend', 30, 14).value, null);
    const v = volatility(series([10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11]), 'trend', 30, 14);
    assert.ok(v.value != null && v.value > 9 && v.value < 11);
  });

  it('Preisumkehr: drei Rückgänge, dann Anstieg', () => {
    assert.equal(reversalSignal(series([20, 18, 16, 14, 15])), true);
    assert.equal(reversalSignal(series([20, 18, 19, 14, 15])), false);
  });

  it('Guide-Kennzahlen und Ausreißererkennung', () => {
    const gm = guideMetrics(guide({ trend: 86.43, avg1: 75.34, avg7: 84.75, avg30: 83.67, low: 59 }));
    assert.equal(gm.refsAvailable, 3);
    assert.equal(gm.avg1VsAvg30Pct, -9.96);
    assert.equal(implausible(gm, 3), false);
    const bad = guideMetrics(guide({ trend: 300, avg1: 20, avg7: 900, avg30: 1000 }));
    assert.equal(bad.refRatio, 50);
    assert.equal(implausible(bad, 3), true);
  });
});

describe('Wiederverkauf', () => {
  const s = settings();
  it('konservativ = Minimum, Basis = Median, optimistisch = Maximum (mit Abschlägen)', () => {
    const r = estimateResale(guide({ trend: 100, avg7: 90, avg30: 110 }), s.resale, 'NM', 'en');
    assert.equal(r.conservative, 79.2);   // 90 × 0,88
    assert.equal(r.base, 95);             // 100 × 0,95
    assert.equal(r.optimistic, 110);
  });
  it('Zustand und Sprache wirken als Faktoren', () => {
    const r = estimateResale(guide({ trend: 100, avg7: 100, avg30: 100 }), s.resale, 'EX', 'fr');
    assert.equal(r.base, 68.4);           // 100 × 0,95 × 0,9 × 0,8
  });
  it('keine Referenzen → keine Schätzung', () => {
    const r = estimateResale(guide({ low: 5 }), s.resale, 'NM', 'en');
    assert.equal(r.base, null);
    assert.equal(r.conservative, null);
  });
});

describe('Buy-Rules', () => {
  const s = settings();
  const ok: RuleInput = {
    referencePrice: 40, profitBase: 8, profitConservative: 2, roiBase: 30, discountPct: 20, capital: 25, inventoryCapital: 0,
    confidence: 70, condition: 'NM', language: 'en', foil: false, offerAgeHours: 1, isOffer: true,
  };
  it('alle Regeln erfüllt', () => assert.equal(evaluateRules(ok, s).passed, true));
  it('Small-Profit-Modus: 3,50 € bei 20 € Kapital und 30 % ROI erlaubt', () => {
    const r = evaluateRules({ ...ok, profitBase: 3.5, roiBase: 30, capital: 20 }, s);
    assert.equal(r.passed, true);
    assert.equal(r.smallProfitMode, true);
  });
  it('Small-Profit-Modus greift nicht bei hoher Kapitalbindung', () => {
    const r = evaluateRules({ ...ok, profitBase: 3.5, roiBase: 30, capital: 60 }, s);
    assert.equal(r.passed, false);
  });
  it('liefert verständliche Begründungen', () => {
    const r = evaluateRules({ ...ok, condition: 'PL', language: 'ja', offerAgeHours: 100, confidence: 20 }, s);
    assert.equal(r.passed, false);
    for (const k of ['Zustand', 'Sprache', 'Angebotsalter', 'Datenqualität']) assert.ok(r.failures.some(f => f.startsWith(k)), k);
  });
  it('Gesamtbestand-Grenze', () => {
    assert.equal(evaluateRules({ ...ok, inventoryCapital: 1990 }, s).passed, false);
  });
});

describe('Strategien und Bewertung', () => {
  const s = settings();
  const product = { id: 1, externalId: 152, name: 'Chrome Mox', setName: 'Mirrodin', setCode: 'MRD', collectorNumber: '152', rarity: 'rare', imageUrl: null, mappingStatus: 'mapped' };

  it('Price-Dip schlägt bei 1-Tages-Ø deutlich unter 30-Tages-Ø an', () => {
    const hit = priceDip(guide({ trend: 40, avg1: 30, avg7: 39, avg30: 40 }), [], s);
    assert.ok(hit);
    assert.equal(hit.buy.price, 30);
    assert.equal(priceDip(guide({ trend: 40, avg1: 38, avg7: 39, avg30: 40 }), [], s), null);
  });

  it('Dip nur im 1-Tages-Ø ist unbestätigt (Confidence-Abzug), mit 7-Tages-Ø bestätigt', () => {
    const lone = priceDip(guide({ trend: 40, avg1: 30, avg7: 39, avg30: 40 }), [], s);
    assert.equal(lone?.confidenceDelta, -10);
    const confirmed = priceDip(guide({ trend: 36, avg1: 30, avg7: 36, avg30: 40 }), [], s);
    assert.equal(confirmed?.confidenceDelta, undefined);
  });

  it('Volatilität allein ist kein Signal: ohne Historie keine Meldung', () => {
    assert.equal(volatilityScan(guide({ trend: 40, avg7: 40, avg30: 40 }), [], s), null);
  });

  it('Volatilität mit Historie und Preis im unteren Bereich', () => {
    const vals = [50, 40, 52, 41, 50, 42, 51, 40, 52, 41, 50, 42, 51, 40, 52, 41, 50, 38];
    const hit = volatilityScan(guide({ trend: 38, avg7: 45, avg30: 46 }), series(vals), s);
    assert.ok(hit);
  });

  it('Spread zum Tiefstpreis hat höchstens Confidence 45 und ist nie ein Kaufauftrag', () => {
    const g = guide({ trend: 86.43, avg1: 84, avg7: 84.75, avg30: 83.67, low: 59 });
    const hit = spreadLow(g, s);
    assert.ok(hit);
    const o = buildOpportunity({ product, finish: 'nonfoil', guide: g, history: [], strategy: hit.strategy, signalClass: 'MARKET_SIGNAL', buy: hit.buy, triggers: hit.triggers, exposure: EMPTY_EXPOSURE, now: Date.now() }, s);
    assert.ok(o.score.confidence <= 45);
    assert.notEqual(o.recommendation, 'KAUFEN');
    assert.ok(o.reasons.some(r => r.includes('Marktsignal')));
  });

  it('Live-Angebot, das alle Regeln erfüllt → KAUFEN mit Begründung', () => {
    const g = guide({ trend: 86.43, avg1: 85, avg7: 84.75, avg30: 83.67, low: 59 });
    const o = buildOpportunity({
      product, finish: 'nonfoil', guide: g, history: [], strategy: 'underpriced_offer', signalClass: 'LIVE_OFFER',
      buy: { price: 55, shipping: null, label: 'Einzelangebot', observedAt: new Date().toISOString(), source: 'extension', condition: 'NM', language: 'en', offerId: 7, offerUrl: 'https://example.invalid/offer', seller: 'x', sellerCountry: 'Deutschland', sellerType: 'pro', sellerSales: 5000, amount: 1, previousPrice: null },
      triggers: [], exposure: EMPTY_EXPOSURE, now: Date.now(),
    }, s);
    assert.equal(o.buy.shipping, 3.95);                  // ≥ 25 € → versichert, Inland
    assert.equal(o.rules.passed, true, o.rules.failures.join('; '));
    assert.equal(o.recommendation, 'KAUFEN');
    assert.ok(o.score.score > 50);
    assert.ok(o.scenarios.conservative && o.scenarios.base && o.scenarios.optimistic);
  });

  it('Simulation wird nie zur Kaufempfehlung', () => {
    const g = guide({ trend: 86.43, avg1: 85, avg7: 84.75, avg30: 83.67 });
    const o = buildOpportunity({
      product, finish: 'nonfoil', guide: g, history: [], strategy: 'underpriced_offer', signalClass: 'SIMULATION',
      buy: { price: 40, shipping: null, label: 'Simuliert', observedAt: new Date().toISOString(), source: 'simulation', condition: 'NM', language: 'en', offerId: 8, offerUrl: null, seller: 'SIM', sellerCountry: 'Deutschland', sellerType: 'pro', sellerSales: 5000, amount: 1, previousPrice: null },
      triggers: [], exposure: EMPTY_EXPOSURE, now: Date.now(),
    }, s);
    assert.equal(o.recommendation, 'NICHT KAUFEN');
    assert.ok(o.reasons[0].startsWith('SIMULATION'));
  });

  it('Niedrige Confidence begrenzt den Score', () => {
    const g = guide({ trend: 86.43, avg1: 85, avg7: 84.75, avg30: 83.67, sourceCreatedAt: new Date(Date.now() - 5 * 864e5).toISOString() });
    const o = buildOpportunity({
      product, finish: 'nonfoil', guide: g, history: [], strategy: 'underpriced_offer', signalClass: 'LIVE_OFFER',
      buy: { price: 40, shipping: null, label: 'alt', observedAt: new Date(Date.now() - 10 * 864e5).toISOString(), source: 'extension', condition: 'NM', language: 'en', offerId: 9, offerUrl: null, seller: 'x', sellerCountry: 'Deutschland', sellerType: 'pro', sellerSales: 5000, amount: 1, previousPrice: null },
      triggers: [], exposure: EMPTY_EXPOSURE, now: Date.now(),
    }, s);
    assert.ok(o.score.confidence < s.rules.minConfidence);
    assert.equal(o.score.capped, true);
    assert.ok(o.score.score <= s.analysis.lowConfidenceScoreCap);
    assert.notEqual(o.recommendation, 'KAUFEN');
  });

  it('historyMetrics meldet die Datenbasis', () => {
    const hm = historyMetrics(series([10, 11]), 14);
    assert.equal(hm.days, 2);
    assert.equal(hm.vol30.value, null);
  });
});
