/**
 * Kapital & Portfolio.
 *
 * Kasse (Handelskonto) wird aus Belegen abgeleitet – nichts wird geschätzt:
 *   + Einlagen − Entnahmen − laufende Kosten − Steuerzahlungen ± Korrekturen   (Kapitalbuch)
 *   − bezahlte Einkäufe (Ware + Porto + Nebenkosten) + Erstattungen aus Einkäufen
 *   + Zahlungseingänge aus Verkäufen (Umsatz − Plattform-/Zahlungsgebühren − Erstattungen)
 *   − Porto, Verpackung, sonstige Kosten versendeter Aufträge
 * Prognosewerte (erwartete Verkaufserlöse) sind ausdrücklich als Prognose gekennzeichnet.
 * Privatbestand ist in keiner dieser Zahlen enthalten.
 */
import { nowIso, type Db } from '../db/database.ts';
import type { AppSettings } from '../domain/settings.ts';
import { estimateResale } from '../analytics/resale.ts';
import type { Exposure } from '../analytics/rules.ts';
import { round2 } from '../util/num.ts';
import { ApiError } from '../api/http.ts';
import { computeOrderResult } from './sales.ts';
import { toGuide } from './products.ts';
import { unitFullCost, type LotRow } from './stock.ts';

export function ledgerTotals(db: Db) {
  const r = db.get<Record<string, number | null>>(`SELECT
      SUM(CASE WHEN type = 'deposit' THEN amount END) AS deposits, SUM(CASE WHEN type = 'withdrawal' THEN amount END) AS withdrawals,
      SUM(CASE WHEN type = 'expense' THEN amount END) AS expenses, SUM(CASE WHEN type = 'tax_payment' THEN amount END) AS tax_payments,
      SUM(CASE WHEN type = 'adjustment' THEN amount END) AS adjustments, COUNT(*) AS n FROM capital_ledger`) ?? {};
  return {
    deposits: r.deposits ?? 0, withdrawals: r.withdrawals ?? 0, expenses: r.expenses ?? 0, taxPayments: r.tax_payments ?? 0,
    adjustments: r.adjustments ?? 0, entries: r.n ?? 0,
  };
}

interface Po { id: number; status: string; shipping_cost: number; other_costs: number; refund_amount: number; paid_at: string | null; goods: number; open_goods: number; open_units: number }

function purchases(db: Db): Po[] {
  return db.all<Po>(`SELECT po.id, po.status, po.shipping_cost, po.other_costs, po.refund_amount, po.paid_at,
      COALESCE(SUM(l.qty * l.unit_price), 0) AS goods, COALESCE(SUM((l.qty - l.received_qty) * l.unit_price), 0) AS open_goods,
      COALESCE(SUM(l.qty - l.received_qty), 0) AS open_units
    FROM purchase_orders po LEFT JOIN purchase_lines l ON l.po_id = po.id GROUP BY po.id`);
}

/** Marktwert-Schätzung (Basisszenario) je Stück für eine Charge oder null. */
function marketUnitValue(db: Db, s: AppSettings, lot: Pick<LotRow, 'product_id' | 'finish' | 'condition' | 'language'>): number | null {
  if (lot.product_id == null) return null;
  const g = db.get<{ avg: number | null; low: number | null; trend: number | null; avg1: number | null; avg7: number | null; avg30: number | null; source_created_at: string }>(
    "SELECT avg, low, trend, avg1, avg7, avg30, source_created_at FROM price_latest WHERE product_id = ? AND finish = ? AND source = 'cardmarket_price_guide'", [lot.product_id, lot.finish]);
  if (!g) return null;
  return estimateResale(toGuide(g), s.resale, lot.condition, lot.language).base;
}

export function portfolioOverview(db: Db, s: AppSettings) {
  const L = ledgerTotals(db);
  const pos = purchases(db);
  const paidPurchases = pos.filter(p => p.paid_at).reduce((a, p) => a + p.goods + p.shipping_cost + p.other_costs, 0);
  const purchaseRefunds = pos.reduce((a, p) => a + p.refund_amount, 0);
  const reservedPurchases = pos.filter(p => !p.paid_at && ['planned', 'ordered', 'problem'].includes(p.status)).reduce((a, p) => a + p.goods + p.shipping_cost + p.other_costs, 0);
  const inTransit = pos.filter(p => p.paid_at && ['paid', 'partially_received', 'problem'].includes(p.status))
    .reduce((a, p) => a + p.open_goods + (p.goods > 0 ? (p.shipping_cost + p.other_costs) * p.open_goods / p.goods : 0), 0);

  const orders = db.all<Record<string, unknown>>('SELECT * FROM sales_orders');
  let salesReceipts = 0, sellingCosts = 0, receivables = 0, realizedRevenue = 0, realizedContribution = 0, vatOutput = 0, vatInput = 0;
  for (const o of orders) {
    // Zahlungsfluss: voller Auftragswert − tatsächliche Erstattungen − Gebühren
    const items = db.get<{ v: number | null }>('SELECT SUM(qty * unit_price) AS v FROM sales_order_lines WHERE order_id = ?', [o.id as number])?.v ?? 0;
    const gross = items + (o.shipping_charged as number) - (o.refund_amount as number);
    const fees = ((o.platform_fee as number | null) ?? 0) + ((o.payment_fee as number | null) ?? 0);
    if (o.payment_status === 'received' || o.payment_status === 'refunded') salesReceipts += gross - fees;
    if (o.shipped_at) {
      sellingCosts += ((o.shipping_cost as number | null) ?? 0) + ((o.packaging_cost as number | null) ?? 0) + ((o.other_costs as number | null) ?? 0);
      if (o.payment_status === 'open') receivables += gross - fees;
      const res = computeOrderResult(db, s, o as never);
      if (res) { realizedRevenue += res.revenueGross; realizedContribution += res.contribution; vatOutput += res.outputVat; vatInput += res.inputVat; }
    }
  }
  const cash = L.deposits - L.withdrawals - L.expenses - L.taxPayments + L.adjustments - paidPurchases + purchaseRefunds + salesReceipts - sellingCosts;

  const lots = db.all<LotRow>("SELECT * FROM stock_lots WHERE ownership = 'business' AND qty_on_hand > 0");
  let stockCost = 0, unsoldCost = 0, unsoldUnits = 0, reservedUnits = 0, slowCost = 0, expected = 0, expectedCovered = 0, expectedMissing = 0;
  const slowBefore = Date.now() - s.limits.slowMoverDays * 864e5;
  const reservedValue = db.get<{ v: number | null }>(`SELECT SUM(a.qty * l.unit_price) AS v FROM sales_allocations a JOIN sales_order_lines l ON l.id = a.line_id WHERE a.status = 'reserved'`)?.v ?? 0;
  for (const l of lots) {
    const unit = unitFullCost(l);
    const free = l.qty_on_hand - l.qty_reserved;
    stockCost += unit * l.qty_on_hand;
    unsoldCost += unit * free;
    unsoldUnits += free;
    reservedUnits += l.qty_reserved;
    if (free > 0 && Date.parse(l.received_at) <= slowBefore) slowCost += unit * free;
    if (free > 0) {
      const v = l.list_price ?? marketUnitValue(db, s, l);
      if (v != null) { expected += v * free; expectedCovered += free; } else expectedMissing += free;
    }
  }
  const vatLiability = vatOutput - vatInput - L.taxPayments;
  const obligations = reservedPurchases + Math.max(0, vatLiability);
  const available = cash - reservedPurchases - s.limits.minLiquidityReserve;
  const totalCapital = cash + stockCost + inTransit + receivables;
  return {
    capitalTracked: L.entries > 0,
    cash: round2(cash),
    totalTradingCapital: round2(totalCapital),
    availableCapital: round2(available),
    reservedForPurchases: round2(reservedPurchases),
    inTransit: round2(inTransit),
    investedInStock: round2(stockCost),
    unsold: { units: unsoldUnits, cost: round2(unsoldCost) },
    reserved: { units: reservedUnits, salesValue: round2(reservedValue) },
    receivables: round2(receivables),
    expectedProceeds: { value: round2(expected + reservedValue), coveredUnits: expectedCovered, unvaluedUnits: expectedMissing, isForecast: true,
      note: 'Prognose: Angebotspreis bzw. Basis-Marktwert der freien Exemplare + Auftragswert reservierter Exemplare. Nicht realisiert.' },
    realizedRevenue: round2(realizedRevenue),
    realizedContribution: round2(realizedContribution),
    openObligations: round2(obligations),
    vatLiabilityEstimate: round2(vatLiability),
    liquidityReserve: s.limits.minLiquidityReserve,
    slowMoverSharePct: stockCost > 0 ? round2(slowCost / stockCost * 100) : 0,
    ledger: L,
    warnings: [
      ...(L.entries === 0 ? ['Kein Handelskapital erfasst: Bitte unter „Kapital & Risiko“ die Einlage buchen – bis dahin ist die Kapitalregel inaktiv.'] : []),
      ...(L.entries > 0 && available < 0 ? [`Verfügbares Kapital ist negativ (${round2(available)} €): Reserve von ${s.limits.minLiquidityReserve} € unterschritten.`] : []),
      ...(stockCost > 0 && slowCost / stockCost * 100 > s.limits.maxSlowMoverSharePct ? [`Anteil langsam verkäuflicher Ware ${round2(slowCost / stockCost * 100)} % > Grenze ${s.limits.maxSlowMoverSharePct} %.`] : []),
      ...(expectedMissing > 0 ? [`${expectedMissing} Exemplar(e) ohne Angebotspreis und ohne Marktwert sind in der Erlösprognose nicht enthalten.`] : []),
    ],
  };
}

/** Bestandssituation für die Kaufregeln (einmal je Analyse-Lauf berechnet). */
export function buildExposure(db: Db, s: AppSettings): Exposure {
  const ov = portfolioOverview(db, s);
  const copies = new Map<string, number>();
  for (const r of db.all<{ product_id: number; finish: string; n: number }>(`SELECT product_id, finish, SUM(qty_on_hand) AS n FROM stock_lots
      WHERE ownership = 'business' AND qty_on_hand > 0 AND product_id IS NOT NULL GROUP BY product_id, finish`)) copies.set(`${r.product_id}:${r.finish}`, r.n);
  const onOrder = new Map<string, number>();
  for (const r of db.all<{ product_id: number; finish: string; n: number }>(`SELECT l.product_id, l.finish, SUM(l.qty - l.received_qty) AS n FROM purchase_lines l
      JOIN purchase_orders po ON po.id = l.po_id WHERE po.status IN ('planned','ordered','paid','partially_received','problem') AND l.product_id IS NOT NULL
      GROUP BY l.product_id, l.finish`)) onOrder.set(`${r.product_id}:${r.finish}`, r.n);
  const setInvested = new Map<string, number>();
  for (const r of db.all<{ set_name: string; v: number }>(`SELECT set_name, SUM(qty_on_hand * (unit_cost + CASE WHEN qty_received > 0 THEN allocated_cost_total / qty_received ELSE 0 END)) AS v
      FROM stock_lots WHERE ownership = 'business' AND qty_on_hand > 0 AND set_name IS NOT NULL GROUP BY set_name`)) setInvested.set(r.set_name, r.v);
  for (const r of db.all<{ set_name: string; v: number }>(`SELECT l.set_name, SUM((l.qty - l.received_qty) * l.unit_price) AS v FROM purchase_lines l
      JOIN purchase_orders po ON po.id = l.po_id WHERE po.status IN ('planned','ordered','paid','partially_received','problem') AND l.set_name IS NOT NULL GROUP BY l.set_name`)) {
    setInvested.set(r.set_name, (setInvested.get(r.set_name) ?? 0) + r.v);
  }
  return {
    investedTotal: ov.investedInStock + ov.inTransit + ov.reservedForPurchases,
    availableCapital: ov.capitalTracked ? ov.availableCapital : null,
    slowSharePct: ov.slowMoverSharePct,
    copies, onOrder, setInvested,
  };
}

// ---------------------------------------------------------------------------- Kapitalbuch

export const LEDGER_TYPES = ['deposit', 'withdrawal', 'expense', 'tax_payment', 'adjustment'] as const;

export function addLedger(db: Db, i: { type: string; amount: number; bookedAt?: string | null; category?: string | null; note?: string | null }): number {
  if (!(LEDGER_TYPES as readonly string[]).includes(i.type)) throw new ApiError(400, `Art: ${LEDGER_TYPES.join(' | ')}`);
  if (typeof i.amount !== 'number' || !Number.isFinite(i.amount) || i.amount === 0) throw new ApiError(400, 'Betrag fehlt');
  if (i.type !== 'adjustment' && i.amount < 0) throw new ApiError(400, 'Betrag positiv eingeben (die Art bestimmt das Vorzeichen); nur Korrekturen dürfen negativ sein');
  if (i.bookedAt && !Number.isFinite(Date.parse(i.bookedAt))) throw new ApiError(400, 'Datum ungültig');
  return db.run('INSERT INTO capital_ledger (type, amount, booked_at, category, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [i.type, i.amount, i.bookedAt ?? nowIso().slice(0, 10), i.category ?? null, i.note ?? null, nowIso()]).lastInsertRowid;
}

export function listLedger(db: Db) {
  return db.all('SELECT id, type, amount, booked_at AS bookedAt, category, note, created_at AS createdAt FROM capital_ledger ORDER BY booked_at DESC, id DESC');
}

export function deleteLedger(db: Db, id: number): void {
  if (!db.run('DELETE FROM capital_ledger WHERE id = ?', [id]).changes) throw new ApiError(404, 'Buchung nicht gefunden');
}

// ---------------------------------------------------------------------------- Bestandswert-Historie

/** Täglicher Schnappschuss: Einstand vs. geschätzter Marktwert des Geschäftsbestands. */
export function snapshotPortfolio(db: Db, s: AppSettings, date = nowIso().slice(0, 10)): void {
  const lots = db.all<LotRow>("SELECT * FROM stock_lots WHERE ownership = 'business' AND qty_on_hand > 0");
  let units = 0, cost = 0, market = 0, covered = 0;
  for (const l of lots) {
    units += l.qty_on_hand;
    cost += unitFullCost(l) * l.qty_on_hand;
    const v = marketUnitValue(db, s, l);
    if (v != null) { market += v * l.qty_on_hand; covered += l.qty_on_hand; }
  }
  db.run(`INSERT INTO portfolio_snapshots (snapshot_date, units, cost_value, market_value, market_covered, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date) DO UPDATE SET units = excluded.units, cost_value = excluded.cost_value, market_value = excluded.market_value,
      market_covered = excluded.market_covered, created_at = excluded.created_at`,
    [date, units, round2(cost), covered ? round2(market) : null, covered, nowIso()]);
}

export function portfolioHistory(db: Db, days = 365) {
  return db.all(`SELECT snapshot_date AS date, units, cost_value AS costValue, market_value AS marketValue, market_covered AS marketCovered
    FROM portfolio_snapshots WHERE snapshot_date >= date('now', ?) ORDER BY snapshot_date`, [`-${days} days`]);
}

/** Konzentration: größte Positionen nach Edition und nach Karte (Risikoübersicht). */
export function concentration(db: Db, s: AppSettings) {
  const bySet = db.all<{ set_name: string | null; units: number; cost: number }>(`SELECT set_name, SUM(qty_on_hand) AS units,
      SUM(qty_on_hand * (unit_cost + CASE WHEN qty_received > 0 THEN allocated_cost_total / qty_received ELSE 0 END)) AS cost
    FROM stock_lots WHERE ownership = 'business' AND qty_on_hand > 0 GROUP BY set_name ORDER BY cost DESC LIMIT 15`);
  const byCard = db.all<{ product_id: number | null; name: string; finish: string; units: number; cost: number }>(`SELECT product_id, name, finish, SUM(qty_on_hand) AS units,
      SUM(qty_on_hand * (unit_cost + CASE WHEN qty_received > 0 THEN allocated_cost_total / qty_received ELSE 0 END)) AS cost
    FROM stock_lots WHERE ownership = 'business' AND qty_on_hand > 0 GROUP BY product_id, name, finish ORDER BY units DESC, cost DESC LIMIT 15`);
  return {
    bySet: bySet.map(r => ({ setName: r.set_name, units: r.units, cost: round2(r.cost), overLimit: r.cost > s.limits.maxInvestmentPerSet })),
    byCard: byCard.map(r => ({ productId: r.product_id, name: r.name, finish: r.finish, units: r.units, cost: round2(r.cost), overLimit: r.units > s.limits.maxCopiesPerCard })),
  };
}
