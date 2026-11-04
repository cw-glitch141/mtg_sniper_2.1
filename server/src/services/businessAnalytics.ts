/**
 * Profit Analytics & Strategievalidierung – ausschließlich aus echten Belegen (versendete Aufträge, Einkäufe,
 * Kapitalbuch, Entscheidungsprotokoll). Prognosen werden getrennt und als solche gekennzeichnet.
 * Simulierte Angebote erzeugen keine Aufträge und tauchen hier daher nicht auf.
 */
import type { Db } from '../db/database.ts';
import type { AppSettings } from '../domain/settings.ts';
import { orderResult, type VatTreatment } from '../analytics/accounting.ts';
import { round2 } from '../util/num.ts';
import { portfolioOverview } from './portfolio.ts';
import { ACTIVE_STATUSES } from './sales.ts';

const MIN_N = 10; // darunter: "zu wenige Daten"

interface AllocResult { allocId: number; lotId: number; orderId: number; month: string; qty: number; costQty: number; revenue: number; cogs: number; contribution: number; storageDays: number; returned: number }
interface OrderRes { id: number; month: string; shippedAt: string; units: number; returnedUnits: number; revenueGross: number; netRevenue: number; contribution: number; cogs: number; laborMinutes: number; vatLiability: number; fees: number; shipping: number; packaging: number; other: number; status: string }

/** Alle versendeten Aufträge mit Ergebnis, plus Ergebnis je Charge/Allokation. */
function realizedData(db: Db, s: AppSettings): { orders: OrderRes[]; allocs: AllocResult[] } {
  const orders = db.all<Record<string, unknown>>('SELECT * FROM sales_orders WHERE shipped_at IS NOT NULL ORDER BY shipped_at');
  const outOrders: OrderRes[] = [];
  const outAllocs: AllocResult[] = [];
  for (const o of orders) {
    const rows = db.all<{ id: number; lot_id: number; qty: number; returned_qty: number; restocked_qty: number; unit_cost: number; unit_alloc: number; unit_price: number; vat_treatment: string; vat_rate_pct: number; received_at: string }>(`
      SELECT a.id, a.lot_id, a.qty, a.returned_qty, a.restocked_qty, a.unit_cost, a.unit_alloc, l.unit_price, s.vat_treatment, s.vat_rate_pct, s.received_at
      FROM sales_allocations a JOIN sales_order_lines l ON l.id = a.line_id JOIN stock_lots s ON s.id = a.lot_id
      WHERE l.order_id = ? AND a.status IN ('shipped','returned') ORDER BY a.id`, [o.id as number]);
    const res = orderResult(rows.map(r => ({ qty: r.qty, costQty: r.qty - r.restocked_qty, unitPrice: r.unit_price, unitCost: r.unit_cost, unitAlloc: r.unit_alloc, treatment: r.vat_treatment as VatTreatment, vatRatePct: r.vat_rate_pct })), {
      shippingCharged: o.shipping_charged as number, shippingCost: (o.shipping_cost as number | null) ?? 0, packagingCost: (o.packaging_cost as number | null) ?? 0,
      platformFee: (o.platform_fee as number | null) ?? 0, paymentFee: (o.payment_fee as number | null) ?? 0, otherCosts: (o.other_costs as number | null) ?? 0,
      refund: o.refund_amount as number,
    }, s);
    const shippedAt = o.shipped_at as string;
    const month = shippedAt.slice(0, 7);
    outOrders.push({
      id: o.id as number, month, shippedAt, units: res.units, returnedUnits: rows.reduce((a, r) => a + r.returned_qty, 0), revenueGross: res.revenueGross,
      netRevenue: res.netRevenue, contribution: res.contribution, cogs: res.cogs, laborMinutes: res.laborMinutes, vatLiability: res.vatLiability,
      fees: res.fees, shipping: res.shipping, packaging: res.packaging, other: res.other, status: o.status as string,
    });
    rows.forEach((r, i) => outAllocs.push({
      allocId: r.id, lotId: r.lot_id, orderId: o.id as number, month, qty: r.qty, costQty: r.qty - r.restocked_qty, revenue: res.lines[i].revenue,
      cogs: res.lines[i].cogs, contribution: res.lines[i].contribution, returned: r.returned_qty,
      storageDays: Math.max(0, (Date.parse(shippedAt) - Date.parse(r.received_at)) / 864e5),
    }));
  }
  return { orders: outOrders, allocs: outAllocs };
}

const monthKey = (iso: string | null | undefined) => (iso ? iso.slice(0, 7) : null);

export function profitAnalytics(db: Db, s: AppSettings) {
  const { orders, allocs } = realizedData(db, s);
  const months = new Map<string, Record<string, number>>();
  const m = (k: string) => {
    let e = months.get(k);
    if (!e) {
      e = { orders: 0, units: 0, returnedUnits: 0, revenueGross: 0, netRevenue: 0, cogs: 0, contribution: 0, laborMinutes: 0, vatLiability: 0, expenses: 0,
        cashIn: 0, cashOut: 0, purchases: 0 };
      months.set(k, e);
    }
    return e;
  };
  for (const o of orders) {
    const e = m(o.month);
    e.orders++; e.units += o.units; e.returnedUnits += o.returnedUnits; e.revenueGross += o.revenueGross; e.netRevenue += o.netRevenue;
    e.cogs += o.cogs; e.contribution += o.contribution; e.laborMinutes += o.laborMinutes; e.vatLiability += o.vatLiability;
    e.cashOut += o.shipping + o.packaging + o.other;
  }
  // Einkaufsarbeit + Zahlungsabflüsse für Einkäufe
  for (const p of db.all<{ received_at: string | null; paid_at: string | null; total: number; refund_amount: number }>(`
      SELECT po.received_at, po.paid_at, po.refund_amount, COALESCE(SUM(l.qty * l.unit_price), 0) + po.shipping_cost + po.other_costs AS total
      FROM purchase_orders po LEFT JOIN purchase_lines l ON l.po_id = po.id GROUP BY po.id`)) {
    const rk = monthKey(p.received_at); if (rk) m(rk).laborMinutes += s.business.laborMinutesPerPurchase;
    const pk = monthKey(p.paid_at); if (pk) { m(pk).cashOut += p.total - p.refund_amount; m(pk).purchases += p.total - p.refund_amount; }
  }
  // Zahlungseingänge aus Verkäufen (nach Zahlungsdatum)
  for (const o of db.all<{ paid_at: string | null; items: number; shipping_charged: number; refund_amount: number; platform_fee: number | null; payment_fee: number | null }>(`
      SELECT o.paid_at, o.shipping_charged, o.refund_amount, o.platform_fee, o.payment_fee, COALESCE(SUM(l.qty * l.unit_price), 0) AS items
      FROM sales_orders o LEFT JOIN sales_order_lines l ON l.order_id = o.id WHERE o.payment_status IN ('received','refunded') GROUP BY o.id`)) {
    const k = monthKey(o.paid_at); if (!k) continue;
    m(k).cashIn += o.items + o.shipping_charged - o.refund_amount - (o.platform_fee ?? 0) - (o.payment_fee ?? 0);
  }
  for (const l of db.all<{ type: string; amount: number; booked_at: string }>('SELECT type, amount, booked_at FROM capital_ledger')) {
    const e = m(l.booked_at.slice(0, 7));
    if (l.type === 'expense') { e.expenses += l.amount; e.cashOut += l.amount; }
    else if (l.type === 'deposit') e.cashIn += l.amount;
    else if (l.type === 'withdrawal' || l.type === 'tax_payment') e.cashOut += l.amount;
    else if (l.type === 'adjustment') { if (l.amount >= 0) e.cashIn += l.amount; else e.cashOut -= l.amount; }
  }
  const hourly = s.fees.hourlyRate;
  const monthly = [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, e]) => ({
    month, orders: e.orders, units: e.units, returnedUnits: e.returnedUnits,
    revenueGross: round2(e.revenueGross), netRevenue: round2(e.netRevenue), cogs: round2(e.cogs), contribution: round2(e.contribution),
    expenses: round2(e.expenses), profitBeforeTax: round2(e.contribution - e.expenses), vatLiability: round2(e.vatLiability),
    laborHours: round2(e.laborMinutes / 60), laborCost: round2(e.laborMinutes / 60 * hourly),
    profitAfterLabor: round2(e.contribution - e.expenses - e.laborMinutes / 60 * hourly),
    profitPerHour: e.laborMinutes > 0 ? round2((e.contribution - e.expenses) / (e.laborMinutes / 60)) : null,
    cashIn: round2(e.cashIn), cashOut: round2(e.cashOut), netCashFlow: round2(e.cashIn - e.cashOut), purchases: round2(e.purchases),
  }));

  const sum = (k: keyof typeof monthly[number]) => monthly.reduce((a, x) => a + ((x[k] as number) ?? 0), 0);
  const units = orders.reduce((a, o) => a + o.units, 0);
  const contribution = orders.reduce((a, o) => a + o.contribution, 0);
  // Aus ungerundeten Minuten rechnen, damit Kachel und Monatstabelle übereinstimmen.
  const laborH = [...months.values()].reduce((a, e) => a + e.laborMinutes, 0) / 60;
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString();
  const cogs12 = orders.filter(o => o.shippedAt >= yearAgo).reduce((a, o) => a + o.cogs, 0);
  const pf = portfolioOverview(db, s);
  const storage = allocs.filter(a => a.costQty > 0);
  const storageUnits = storage.reduce((a, x) => a + x.costQty, 0);
  const current = new Date().toISOString().slice(0, 7);
  const cur = monthly.find(x => x.month === current);
  const openOrders = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sales_orders WHERE status IN (${ACTIVE_STATUSES.map(x => `'${x}'`).join(',')})`)?.n ?? 0;
  const returned = orders.reduce((a, o) => a + o.returnedUnits, 0);
  const validation = strategyValidation(db, s);

  return {
    basis: 'Realisierte Ergebnisse aus versendeten Aufträgen (keine Prognose).',
    kpis: {
      monthRevenue: cur?.revenueGross ?? 0,
      monthContribution: cur?.contribution ?? 0,
      salesUnitsTotal: units,
      ordersTotal: orders.length,
      avgProfitPerCard: units ? round2(contribution / units) : null,
      avgProfitPerOrder: orders.length ? round2(contribution / orders.length) : null,
      profitPerLaborHour: laborH > 0 ? round2((contribution - sum('expenses')) / laborH) : null,
      avgStorageDays: storageUnits ? round2(storage.reduce((a, x) => a + x.storageDays * x.costQty, 0) / storageUnits) : null,
      inventoryTurnover: pf.investedInStock > 0 ? round2(cogs12 / pf.investedInStock) : null,
      capitalBound: round2(pf.investedInStock + pf.inTransit),
      currentStockUnits: pf.unsold.units + pf.reserved.units,
      openOrders,
      returnRatePct: units ? round2(returned / units * 100) : null,
      recommendationSuccessPct: validation.overall.successRatePct,
      recommendationSample: validation.overall.decisionsWithSales,
    },
    totals: {
      revenueGross: round2(sum('revenueGross')), netRevenue: round2(sum('netRevenue')), contribution: round2(contribution), expenses: round2(sum('expenses')),
      profitBeforeTax: round2(contribution - sum('expenses')), vatLiability: round2(sum('vatLiability')), laborHours: round2(laborH),
      cashIn: round2(sum('cashIn')), cashOut: round2(sum('cashOut')),
    },
    forecast: { isForecast: true, expectedProceeds: pf.expectedProceeds, unsold: pf.unsold, note: 'Prognose – nicht realisiert.' },
    monthly,
  };
}

// ---------------------------------------------------------------------------- Strategievalidierung

interface DecisionRow { id: number; created_at: string; decision: string; strategy: string; signal_class: string; score: number; confidence: number; buy_price: number; expected_profit_base: number | null; payload: string; purchase_line_id: number | null; opportunity_key: string }

function band(v: number | null, edges: number[], unit = ''): string {
  if (v == null) return 'unbekannt';
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return i === 0 ? `< ${edges[0]}${unit}` : `${edges[i - 1]}–${edges[i]}${unit}`;
  return `≥ ${edges[edges.length - 1]}${unit}`;
}

export function strategyValidation(db: Db, s: AppSettings) {
  const { allocs } = realizedData(db, s);
  const byLot = new Map<number, AllocResult[]>();
  for (const a of allocs) { const l = byLot.get(a.lotId) ?? []; l.push(a); byLot.set(a.lotId, l); }

  const decisions = db.all<DecisionRow>(`SELECT d.id, d.created_at, d.decision, d.strategy, d.signal_class, d.score, d.confidence, d.buy_price, d.expected_profit_base,
      d.payload, COALESCE(d.purchase_line_id, (SELECT id FROM purchase_lines WHERE decision_id = d.id LIMIT 1)) AS purchase_line_id, d.opportunity_key
    FROM decisions d ORDER BY d.id`);
  const recLog = db.all<{ strategy: string; signal_class: string; n: number }>('SELECT strategy, signal_class, COUNT(*) AS n FROM recommendation_log GROUP BY strategy, signal_class');

  const rows = decisions.filter(d => d.decision === 'accepted').map(d => {
    const o = JSON.parse(d.payload) as { name?: string; setName?: string | null; rarity?: string | null; finish?: string; discountPct?: number | null; priority?: string | null };
    const lots = d.purchase_line_id ? db.all<{ id: number; qty_received: number; qty_on_hand: number; unit_cost: number; allocated_cost_total: number }>(
      'SELECT id, qty_received, qty_on_hand, unit_cost, allocated_cost_total FROM stock_lots WHERE purchase_line_id = ?', [d.purchase_line_id]) : [];
    const sold = lots.flatMap(l => byLot.get(l.id) ?? []);
    const unitsBought = lots.reduce((a, l) => a + l.qty_received, 0);
    const unitsSold = sold.reduce((a, x) => a + x.qty - x.returned, 0);
    const contribution = sold.reduce((a, x) => a + x.contribution, 0);
    const days = sold.length ? sold.reduce((a, x) => a + x.storageDays * x.qty, 0) / Math.max(1, sold.reduce((a, x) => a + x.qty, 0)) : null;
    const bound = lots.reduce((a, l) => a + l.qty_on_hand * (l.unit_cost + (l.qty_received ? l.allocated_cost_total / l.qty_received : 0)), 0);
    return {
      decisionId: d.id, name: o.name ?? '?', setName: o.setName ?? null, strategy: d.strategy, signalClass: d.signal_class, priority: o.priority ?? 'ohne', rarity: o.rarity ?? 'unbekannt', finish: o.finish ?? 'nonfoil',
      priceBand: band(d.buy_price, [15, 30, 60, 120, 250], ' €'), scoreBand: band(d.score, [50, 60, 70, 80]), confidenceBand: band(d.confidence, [50, 60, 70, 80]),
      score: d.score, confidence: d.confidence, discountPct: o.discountPct ?? null,
      expectedProfit: d.expected_profit_base, unitsBought, unitsSold, contribution: round2(contribution),
      contributionPerUnit: unitsSold ? round2(contribution / unitsSold) : null, loss: unitsSold > 0 && contribution < 0, daysToSell: days == null ? null : round2(days),
      boundCapital: round2(bound),
    };
  });

  const group = (key: keyof typeof rows[number]) => {
    const g = new Map<string, typeof rows>();
    for (const r of rows) { const k = String(r[key]); g.set(k, [...(g.get(k) ?? []), r]); }
    return [...g.entries()].map(([k, list]) => {
      const sold = list.filter(r => r.unitsSold > 0);
      const unitsSold = list.reduce((a, r) => a + r.unitsSold, 0);
      const unitsBought = list.reduce((a, r) => a + r.unitsBought, 0);
      const db_ = list.reduce((a, r) => a + r.contribution, 0);
      return {
        group: k, decisions: list.length, unitsBought, unitsSold, sellThroughPct: unitsBought ? round2(unitsSold / unitsBought * 100) : null,
        avgDaysToSell: sold.length ? round2(sold.reduce((a, r) => a + (r.daysToSell ?? 0), 0) / sold.length) : null,
        contribution: round2(db_), contributionPerUnit: unitsSold ? round2(db_ / unitsSold) : null,
        lossDecisions: list.filter(r => r.loss).length, profitableDecisions: list.filter(r => r.unitsSold > 0 && r.contribution > 0).length,
        boundCapital: round2(list.reduce((a, r) => a + r.boundCapital, 0)), insufficient: list.length < MIN_N,
      };
    }).sort((a, b) => b.decisions - a.decisions);
  };

  // Filter-Test: Welche Mindestwerte hätten (nachträglich) die realisierten Ergebnisse verbessert?
  const withSales = rows.filter(r => r.unitsSold > 0);
  const filterTests: { filter: string; threshold: number; decisions: number; contributionPerUnit: number | null; lossSharePct: number | null; insufficient: boolean }[] = [];
  const test = (filter: string, thresholds: number[], val: (r: typeof rows[number]) => number | null) => {
    for (const t of thresholds) {
      const sel = withSales.filter(r => (val(r) ?? -Infinity) >= t);
      const u = sel.reduce((a, r) => a + r.unitsSold, 0);
      filterTests.push({ filter, threshold: t, decisions: sel.length, contributionPerUnit: u ? round2(sel.reduce((a, r) => a + r.contribution, 0) / u) : null,
        lossSharePct: sel.length ? round2(sel.filter(r => r.loss).length / sel.length * 100) : null, insufficient: sel.length < MIN_N });
    }
  };
  test('Mindest-Score', [0, 50, 60, 70, 80], r => r.score);
  test('Mindest-Confidence', [0, 50, 60, 70], r => r.confidence);
  test('Mindest-Rabatt %', [0, 15, 25, 35], r => r.discountPct);

  const accepted = rows.length;
  const rejected = decisions.filter(d => d.decision === 'rejected').length;
  const logged = recLog.reduce((a, r) => a + r.n, 0);
  return {
    minSample: MIN_N,
    note: `Nur reale Entscheidungen und Verkäufe. Gruppen mit weniger als ${MIN_N} Entscheidungen sind als "zu wenige Daten" markiert – daraus keine Schlüsse ziehen.`,
    overall: {
      recommendationsLogged: logged, accepted, rejected,
      boughtSharePct: logged ? round2(accepted / logged * 100) : null,
      decisionsWithSales: withSales.length,
      unitsBought: rows.reduce((a, r) => a + r.unitsBought, 0), unitsSold: rows.reduce((a, r) => a + r.unitsSold, 0),
      successRatePct: withSales.length ? round2(withSales.filter(r => r.contribution > 0).length / withSales.length * 100) : null,
      meanPredictionErrorPerUnit: (() => {
        const e = withSales.filter(r => r.expectedProfit != null && r.contributionPerUnit != null);
        return e.length ? round2(e.reduce((a, r) => a + ((r.contributionPerUnit as number) - (r.expectedProfit as number)), 0) / e.length) : null;
      })(),
      boundCapital: round2(rows.reduce((a, r) => a + r.boundCapital, 0)),
    },
    recommendationsByStrategy: recLog,
    byStrategy: group('strategy'), bySignalClass: group('signalClass'), byPriority: group('priority'), byPriceBand: group('priceBand'),
    byRarity: group('rarity'), byFinish: group('finish'), byScoreBand: group('scoreBand'), byConfidenceBand: group('confidenceBand'),
    lossMakers: rows.filter(r => r.loss).sort((a, b) => a.contribution - b.contribution).slice(0, 20),
    filterTests,
  };
}
