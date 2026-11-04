import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { allocateCents, minSellPrice, orderResult } from '../src/analytics/accounting.ts';
import { buildOpportunity } from '../src/analytics/opportunity.ts';
import { Db, migrate } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { addLedger, buildExposure, portfolioOverview } from '../src/services/portfolio.ts';
import { createPurchase, getPurchase, receiveLine, setPurchaseStatus, updatePurchaseCosts } from '../src/services/purchases.ts';
import { applyPrice, repricingSuggestions } from '../src/services/repricing.ts';
import {
  createOrder, getOrder, importOrdersCsv, reportMissing, resolveMissing, resolveProblem, returnItems, setOrderStatus,
} from '../src/services/sales.ts';
import { createLot, getLot, splitLot } from '../src/services/stock.ts';
import { runPipeline } from '../src/services/pipeline.ts';
import { guide, settings, testApp, type TestApp } from './helpers.ts';

const s0 = settings();
const SHIP = { shippingCost: 1.1, packagingCost: 0.3, platformFee: 1 };

/** Bestandsinvariante: Summe der bestandswirksamen Bewegungen = qty_on_hand, 0 ≤ reserviert ≤ Bestand. */
function assertInvariants(db: Db) {
  const lots = db.all<{ id: number; qty_on_hand: number; qty_reserved: number }>('SELECT id, qty_on_hand, qty_reserved FROM stock_lots');
  for (const l of lots) {
    const sum = db.get<{ n: number }>("SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movements WHERE lot_id = ? AND type NOT IN ('reserve','release','move')", [l.id])?.n;
    assert.equal(sum, l.qty_on_hand, `Bewegungen ≠ Bestand bei Charge ${l.id}`);
    assert.ok(l.qty_reserved >= 0 && l.qty_reserved <= l.qty_on_hand);
    const res = db.get<{ n: number }>("SELECT COALESCE(SUM(qty), 0) AS n FROM sales_allocations WHERE lot_id = ? AND status = 'reserved'", [l.id])?.n;
    assert.equal(res, l.qty_reserved, `Reservierungen ≠ qty_reserved bei Charge ${l.id}`);
  }
}

describe('Buchhaltung (rein rechnerisch)', () => {
  it('Nebenkosten werden centgenau verteilt', () => {
    const a = allocateCents(3.95, [10, 20]);
    assert.deepEqual(a, [1.32, 2.63]);
    assert.equal(Math.round(allocateCents(1, [1, 1, 1]).reduce((x, y) => x + y, 0) * 100), 100);
  });

  it('Versand nur einmal je Auftrag, auch bei mehreren Karten (Kleinunternehmer)', () => {
    const r = orderResult([
      { qty: 2, unitPrice: 10, unitCost: 5, unitAlloc: 0.5, treatment: 'none', vatRatePct: 19 },
      { qty: 1, unitPrice: 20, unitCost: 12, unitAlloc: 1, treatment: 'none', vatRatePct: 19 },
    ], { shippingCharged: 1.25, shippingCost: 1.1, packagingCost: 0.3, platformFee: 2, paymentFee: 0, otherCosts: 0, refund: 0 }, s0);
    // Umsatz 41,25; Wareneinsatz 11 + 13 = 24; DB = 41,25 − 24 − 2 − 1,1 − 0,3 = 13,85
    assert.equal(r.revenueGross, 41.25);
    assert.equal(r.cogs, 24);
    assert.equal(r.contribution, 13.85);
    assert.equal(r.units, 3);
    // Arbeitszeit: 6 min je Auftrag + 3 × 1,5 min = 10,5 min
    assert.equal(r.laborMinutes, 10.5);
    assert.equal(Math.round(r.lines.reduce((a, l) => a + l.contribution, 0) * 100) / 100, 13.85);
  });

  it('Differenzbesteuerung je Charge: Einkauf mit Rechnung wird regulär versteuert', () => {
    const s = settings(x => { x.tax.mode = 'margin'; });
    const r = orderResult([
      { qty: 1, unitPrice: 30, unitCost: 20, unitAlloc: 0, treatment: 'none', vatRatePct: 19 },        // §25a: USt auf 10 €
      { qty: 1, unitPrice: 30, unitCost: 23.8, unitAlloc: 0, treatment: 'vat_invoice', vatRatePct: 19 }, // regulär: USt auf 30 €, Vorsteuer 3,80
    ], { shippingCharged: 0, shippingCost: 0, packagingCost: 0, platformFee: 0, paymentFee: 0, otherCosts: 0, refund: 0 }, s);
    assert.equal(r.outputVat, Math.round((10 * 19 / 119 + 30 * 19 / 119) * 100) / 100);
    assert.equal(r.inputVat, 3.8);
    assert.equal(r.vatLiability, Math.round((r.outputVat - 3.8) * 100) / 100);
  });

  it('Mindestverkaufspreis ergibt Deckungsbeitrag ≈ 0 und steigt mit dem Gewinnziel', () => {
    const be = minSellPrice(20, 1, 'none', 19, s0, 0, 0);
    const tgt = minSellPrice(20, 1, 'none', 19, s0, 3, 10);
    assert.ok(be > 21 && be < 23, `Break-even ${be}`);
    assert.ok(tgt > be);
  });
});

describe('Lager, Einkauf und Aufträge', () => {
  let t: TestApp;
  let db: Db;
  const s = () => t.ctx.settings.get();
  before(async () => { t = testApp(); db = t.ctx.db; await runPipeline(t.ctx, { scryfall: false }); });
  after(async () => { await t.cleanup(); });
  beforeEach(() => assertInvariants(db));

  it('Einkauf: Nebenkosten-Verteilung, Teillieferung, Statusfolge', () => {
    const po = createPurchase(db, { supplier: 'V1', status: 'ordered', shippingCost: 3.95, lines: [
      { productId: 1, condition: 'NM', language: 'en', qty: 2, unitPrice: 5 }, { productId: 2, condition: 'NM', language: 'en', qty: 1, unitPrice: 20 },
    ] });
    const p = getPurchase(db, po);
    assert.deepEqual(p.lines.map(l => l.allocatedCosts), [1.32, 2.63]);
    const l1 = receiveLine(db, s(), p.lines[0].id, { qty: 1, locationCode: 'A01' });
    assert.equal(getPurchase(db, po).status, 'partially_received');
    assert.throws(() => receiveLine(db, s(), p.lines[0].id, { qty: 2 }), /nur noch 1/);
    assert.throws(() => receiveLine(db, s(), p.lines[0].id, { qty: 1, locationCode: 'Regal 7' }), /passt nicht/);
    receiveLine(db, s(), p.lines[0].id, { qty: 1, locationCode: 'A01' });
    receiveLine(db, s(), p.lines[1].id, { qty: 1, locationCode: 'B02' });
    const done = getPurchase(db, po);
    assert.equal(done.status, 'received');
    assert.equal(getLot(db, l1).allocated_cost_total, 0.66);
    // Nachträglich höheres Porto → Chargen werden neu belastet
    updatePurchaseCosts(db, po, { shippingCost: 5 });
    // 5 € → 1,67 € auf Position 1 (2 Stück) → 0,835 € je Stück, auf Cent gerundet
    assert.ok(Math.abs(getLot(db, l1).allocated_cost_total - 0.835) <= 0.0051);
  });

  it('Mehrere Chargen mit unterschiedlichem Einstand: FIFO-Reservierung über Chargen hinweg', () => {
    const a = createLot(db, s(), { productId: 2, condition: 'EX', language: 'de', qty: 2, unitCost: 10, acquiredAt: '2026-01-01', locationCode: 'C01' });
    const b = createLot(db, s(), { productId: 2, condition: 'EX', language: 'de', qty: 2, unitCost: 14, locationCode: 'C02' });
    const o = createOrder(db, { externalOrderId: 'FIFO-1', lines: [{ productId: 2, condition: 'EX', language: 'de', qty: 3, unitPrice: 30 }] });
    assert.equal(getLot(db, a).qty_reserved, 2);
    assert.equal(getLot(db, b).qty_reserved, 1);
    const view = getOrder(db, s(), o);
    assert.deepEqual(view.lines?.[0].allocations.map(x => x.qty), [2, 1]);
  });

  it('Reservierte Karten sind für weitere Aufträge nicht verfügbar – kein Teil-Auftrag bei Fehlbestand', () => {
    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sales_orders')?.n;
    assert.throws(() => createOrder(db, { externalOrderId: 'FIFO-2', lines: [{ productId: 2, condition: 'EX', language: 'de', qty: 2, unitPrice: 30 }] }), /frei 1/);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sales_orders')?.n, before, 'fehlgeschlagener Auftrag darf nichts hinterlassen');
    createOrder(db, { externalOrderId: 'FIFO-3', lines: [{ productId: 2, condition: 'EX', language: 'de', qty: 1, unitPrice: 31 }] });
    assert.throws(() => createOrder(db, { externalOrderId: 'FIFO-4', lines: [{ productId: 2, condition: 'EX', language: 'de', qty: 1, unitPrice: 31 }] }), /frei 0/);
  });

  it('Doppelte Aufträge werden erkannt', () => {
    assert.throws(() => createOrder(db, { externalOrderId: 'FIFO-3', lines: [{ productId: 1, qty: 1, unitPrice: 1 }] }), /Dublette/);
  });

  it('Storno gibt Reservierungen frei; versendete Aufträge lassen sich nicht stornieren', () => {
    const id = db.get<{ id: number }>("SELECT id FROM sales_orders WHERE external_order_id = 'FIFO-3'")!.id;
    setOrderStatus(db, id, { status: 'cancelled' });
    const free = db.get<{ n: number }>("SELECT SUM(qty_on_hand - qty_reserved) AS n FROM stock_lots WHERE product_id = 2 AND condition = 'EX'")?.n;
    assert.equal(free, 1);
    const o = db.get<{ id: number }>("SELECT id FROM sales_orders WHERE external_order_id = 'FIFO-1'")!.id;
    setOrderStatus(db, o, { status: 'checked', paymentReceived: true });
    setOrderStatus(db, o, { status: 'packed' });
    setOrderStatus(db, o, { status: 'shipped', ...SHIP });
    assert.throws(() => setOrderStatus(db, o, { status: 'cancelled' }), /nicht erlaubt/);
    // Einstand: 2 × 10 + 1 × 14 = 34
    assert.equal(getOrder(db, s(), o).result?.cogs, 34);
  });

  it('Teilrücksendung mit und ohne Wiedereinlagerung', () => {
    const o = db.get<{ id: number }>("SELECT id FROM sales_orders WHERE external_order_id = 'FIFO-1'")!.id;
    const view = getOrder(db, s(), o);
    const lineId = view.lines![0].id;
    const contribBefore = view.result!.contribution;
    returnItems(db, o, [{ lineId, qty: 1, restock: true }], 30);
    const after1 = getOrder(db, s(), o);
    assert.equal(after1.status, 'shipped');
    // Umsatz −30, Wareneinsatz −10 (älteste Charge zurück ins Lager)
    assert.equal(Math.round((contribBefore - after1.result!.contribution) * 100) / 100, 20);
    returnItems(db, o, [{ lineId, qty: 2, restock: false }], 60);
    const after2 = getOrder(db, s(), o);
    assert.equal(after2.status, 'returned');
    assert.throws(() => returnItems(db, o, [{ lineId, qty: 1, restock: true }], 0), /nur für versendete/);
    assertInvariants(db);
  });

  it('Fehlende Karte: Ausbuchung, PROBLEM, Nachreservierung oder Kürzung', () => {
    createLot(db, s(), { productId: 1, condition: 'NM', language: 'de', qty: 1, unitCost: 50, locationCode: 'D01' });
    createLot(db, s(), { productId: 1, condition: 'NM', language: 'de', qty: 1, unitCost: 52, locationCode: 'D02' });
    const o = createOrder(db, { externalOrderId: 'MISS-1', paymentReceived: true, lines: [
      { productId: 1, condition: 'NM', language: 'de', qty: 1, unitPrice: 80 }, { productId: 2, condition: 'NM', language: 'en', qty: 1, unitPrice: 30 },
    ] });
    const lines = getOrder(db, s(), o).lines!;
    reportMissing(db, lines[0].id, 1);
    assert.equal(getOrder(db, s(), o).status, 'problem');
    assert.throws(() => resolveProblem(db, o), /fehlen/);
    resolveMissing(db, lines[0].id, 'reallocate');
    resolveProblem(db, o);
    assert.equal(getOrder(db, s(), o).status, 'new');
    reportMissing(db, lines[0].id, 1);
    assert.throws(() => resolveMissing(db, lines[0].id, 'reallocate'), /frei 0/);
    resolveMissing(db, lines[0].id, 'drop');
    resolveProblem(db, o);
    const v = getOrder(db, s(), o);
    assert.equal(v.lines!.length, 1);
    assert.match(v.notes ?? '', /80\.00 € an Käufer erstatten/);
    assertInvariants(db);
  });

  it('CSV-Import: Mehrpositions-Aufträge, Dubletten und fehlerhafte Zeilen', () => {
    createLot(db, s(), { productId: 1, condition: 'GD', language: 'en', qty: 3, unitCost: 30, locationCode: 'E01' });
    const csv = [
      'order_id;platform;buyer;paid;shipping_charged;idProduct;condition;language;qty;price',
      'CSV-1;cardmarket;Anna;ja;1,25;152;GD;en;1;60,00',
      'CSV-1;cardmarket;Anna;ja;1,25;152;GD;en;1;61,00',
      'CSV-2;cardmarket;Bob;ja;1,25;152;GD;en;1;abc',
      'CSV-3;cardmarket;Cleo;nein;0;152;GD;en;5;50',
      ';cardmarket;Nobody;ja;0;152;GD;en;1;10',
      'FIFO-1;cardmarket;X;ja;0;152;GD;en;1;10',
    ].join('\n');
    const r = importOrdersCsv(db, csv);
    assert.deepEqual(r.created.map(c => c.externalOrderId), ['CSV-1']);
    assert.deepEqual(r.duplicates, ['FIFO-1']);
    assert.equal(r.failed.length, 3);
    assert.ok(r.failed.some(f => /Preis/.test(f.error)) && r.failed.some(f => /frei 1/.test(f.error)) && r.failed.some(f => /order_id/.test(f.error)));
    assert.equal(getOrder(db, s(), r.created[0].orderId).lines!.length, 2);
  });

  it('Privatbestand ist strikt getrennt', () => {
    const lot = createLot(db, s(), { productId: 3, condition: 'NM', language: 'en', qty: 4, unitCost: 1, locationCode: 'F01' });
    const priv = splitLot(db, s(), lot, 3, { ownership: 'private', privateDeck: 'Commander' });
    assert.equal(getLot(db, priv).ownership, 'private');
    assert.equal(getLot(db, lot).qty_on_hand, 1);
    assert.throws(() => createOrder(db, { externalOrderId: 'PRIV-1', lines: [{ productId: 3, condition: 'NM', language: 'en', qty: 2, unitPrice: 2 }] }), /frei 1/);
    assert.throws(() => createOrder(db, { externalOrderId: 'PRIV-2', lines: [{ lotId: priv, qty: 1, unitPrice: 2 }] }), /Privatbestand/);
    const ov = portfolioOverview(db, s());
    const biz = db.get<{ v: number }>(`SELECT SUM(qty_on_hand * (unit_cost + CASE WHEN qty_received > 0 THEN allocated_cost_total / qty_received ELSE 0 END)) AS v
      FROM stock_lots WHERE ownership = 'business'`)!.v;
    assert.equal(ov.investedInStock, Math.round(biz * 100) / 100, 'Geschäftszahlen enthalten keinen Privatbestand');
    assert.equal(db.get<{ n: number }>("SELECT SUM(qty_on_hand) AS n FROM stock_lots WHERE ownership = 'private'")?.n, 3);
  });
});

describe('Kapital, Limits, Repricing, Priorität', () => {
  let t: TestApp;
  let db: Db;
  const s = () => t.ctx.settings.get();
  before(async () => { t = testApp(); db = t.ctx.db; await runPipeline(t.ctx, { scryfall: false }); });
  after(async () => { await t.cleanup(); });

  it('Kasse, reservierte Einkäufe und verfügbares Kapital', () => {
    let ov = portfolioOverview(db, s());
    assert.equal(ov.capitalTracked, false);
    addLedger(db, { type: 'deposit', amount: 1000 });
    const planned = createPurchase(db, { status: 'planned', shippingCost: 2, lines: [{ productId: 1, qty: 1, unitPrice: 98 }] });
    ov = portfolioOverview(db, s());
    assert.equal(ov.cash, 1000);
    assert.equal(ov.reservedForPurchases, 100);
    assert.equal(ov.availableCapital, 1000 - 100 - s().limits.minLiquidityReserve);
    setPurchaseStatus(db, planned, 'paid');
    ov = portfolioOverview(db, s());
    assert.equal(ov.cash, 900);
    assert.equal(ov.inTransit, 100);
    assert.equal(ov.reservedForPurchases, 0);
    assert.throws(() => addLedger(db, { type: 'expense', amount: -5 }), /positiv/);
  });

  it('Bestand dieser Karte begrenzt weitere Käufe (keine unkontrollierten Nachkäufe)', () => {
    for (let i = 0; i < 2; i++) createLot(db, s(), { productId: 1, condition: 'NM', language: 'en', qty: 2, unitCost: 50 });
    const ex = buildExposure(db, s());
    assert.equal(ex.copies.get('1:nonfoil'), 4);
    assert.equal(ex.onOrder.get('1:nonfoil'), 1);
    const product = { id: 1, externalId: 152, name: 'Chrome Mox', setName: 'Mirrodin', setCode: 'MRD', collectorNumber: '152', rarity: 'rare', imageUrl: null, mappingStatus: 'mapped' };
    const o = buildOpportunity({
      product, finish: 'nonfoil', guide: guide({ trend: 86.43, avg1: 85, avg7: 84.75, avg30: 83.67 }), history: [], strategy: 'underpriced_offer', signalClass: 'LIVE_OFFER',
      buy: { price: 50, shipping: null, label: 'x', observedAt: new Date().toISOString(), source: 'extension', condition: 'NM', language: 'en', offerId: 1, offerUrl: null, seller: 'S', sellerCountry: 'Deutschland', sellerType: 'pro', sellerSales: 9999, amount: 1, previousPrice: null },
      triggers: [], exposure: ex, now: Date.now(),
    }, s());
    assert.equal(o.rules.passed, false);
    assert.ok(o.rules.failures.some(f => f.startsWith('Exemplare dieser Karte')));
    assert.ok(o.reasons.some(r => r.includes('Bereits 4 Exemplar')));
    assert.equal(o.recommendation, 'NICHT KAUFEN');
    assert.equal(o.priority, null);
  });

  it('HIGH vs. MEDIUM: frisches Angebot mit hoher konservativer Rentabilität', () => {
    const product = { id: 2, externalId: 1001, name: 'Test Dip Card', setName: 'Testset', setCode: 'TST', collectorNumber: '1', rarity: 'rare', imageUrl: null, mappingStatus: 'mapped' };
    const g = guide({ trend: 86.43, avg1: 85, avg7: 84.75, avg30: 83.67 });
    const mk = (price: number, ageH: number) => buildOpportunity({
      product, finish: 'nonfoil', guide: g, history: [], strategy: 'underpriced_offer', signalClass: 'LIVE_OFFER',
      buy: { price, shipping: null, label: 'x', observedAt: new Date(Date.now() - ageH * 36e5).toISOString(), source: 'extension', condition: 'NM', language: 'en', offerId: 9, offerUrl: 'https://www.cardmarket.com/de/Magic/Products/Singles/Testset/Test-Dip-Card', seller: 'S', sellerCountry: 'Deutschland', sellerType: 'pro', sellerSales: 9999, amount: 1, previousPrice: null },
      triggers: [], exposure: buildExposure(db, s()), now: Date.now(),
    }, s());
    assert.equal(mk(50, 1).priority, 'HIGH');
    assert.equal(mk(50, 20).priority, 'MEDIUM', 'älter als 12 h → nur MEDIUM');
  });

  it('Repricing: nie unter der Untergrenze, Bestätigung für Preise darunter', () => {
    const lot = createLot(db, s(), { productId: 2, condition: 'NM', language: 'en', qty: 1, unitCost: 45, allocatedCostTotal: 2, locationCode: 'G01' });
    db.run('UPDATE stock_lots SET list_price = 99, listed_at = ? WHERE id = ?', [new Date().toISOString(), lot]);
    const sug = repricingSuggestions(db, s()).find(x => x.lotId === lot)!;
    // Marktwert (Basis) für 40 € Trend liegt unter der Verlustgrenze eines 47-€-Einstands
    assert.equal(sug.action, 'overpriced');
    assert.ok(sug.suggested! >= sug.floor);
    assert.ok(sug.breakEven > 47);
    assert.ok(sug.notes.some(n => n.includes('unter der Verlustgrenze')));
    for (const x of repricingSuggestions(db, s())) if (x.suggested != null) assert.ok(x.suggested >= x.floor, `${x.lotCode}: ${x.suggested} < ${x.floor}`);
    assert.throws(() => applyPrice(db, s(), lot, 30), /Untergrenze/);
    applyPrice(db, s(), lot, 30, true);
    assert.equal(getLot(db, lot).list_price, 30);
    assert.equal(repricingSuggestions(db, s()).find(x => x.lotId === lot)!.action, 'below_floor');
  });
});

describe('Watchlist-Filter je Eintrag', () => {
  it('eigener Mindestzustand/Sprachen überschreiben die globale Regel, sonst gilt sie', async () => {
    const t = testApp();
    try {
      const { addWatch, listWatch, offerMatchesEntry, updateWatch } = await import('../src/services/watchlist.ts');
      const e = addWatch(t.ctx.db, { name: 'Chrome Mox', minCondition: 'GD', languages: ['ja'] });
      assert.equal(e.minCondition, 'GD');
      assert.deepEqual(e.languages, ['ja']);
      assert.equal(offerMatchesEntry(e, { condition: 'GD', language: 'ja' }, 'EX', ['en', 'de']), true);
      assert.equal(offerMatchesEntry(e, { condition: 'LP', language: 'ja' }, 'EX', ['en', 'de']), false);
      assert.equal(offerMatchesEntry(e, { condition: 'NM', language: 'en' }, 'EX', ['en', 'de']), false, 'eigene Sprachliste gilt');
      updateWatch(t.ctx.db, e.id, { minCondition: null, languages: null });
      const g = listWatch(t.ctx.db)[0];
      assert.equal(offerMatchesEntry(g, { condition: 'NM', language: 'en' }, 'EX', ['en', 'de']), true);
      assert.equal(offerMatchesEntry(g, { condition: 'GD', language: 'en' }, 'EX', ['en', 'de']), false, 'globale Mindestgrenze EX');
    } finally { await t.cleanup(); }
  });
});

describe('Datenbankmigration 2.0 → 2.1 ohne Datenverlust', () => {
  it('überführt Journal-Posten in Einkauf, Charge und Verkauf und behält die alte Tabelle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mtgds-mig-'));
    const db = new Db(join(dir, 'm.sqlite'));
    try {
      db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      db.exec(MIGRATIONS[0].sql);
      db.run("INSERT INTO schema_migrations VALUES (1, 'initial schema', '2026-11-04')");
      const now = '2026-11-04T10:00:00Z';
      const ins = (status: string, sell: number | null) => db.run(`INSERT INTO inventory (name, set_name, condition, language, finish, qty, buy_price, buy_shipping, buy_other_costs, buy_date,
          seller, status, sell_price, sell_date, platform_fees, sell_shipping_cost, created_at, updated_at)
        VALUES ('Karte', 'Set', 'NM', 'en', 'nonfoil', 2, 10, 1.5, 0.5, '2026-10-01', 'S', ?, ?, ?, ?, 0.5, ?, ?)`, [status, sell, sell ? '2026-10-20' : null, sell ? 1 : null, now, now]);
      ins('listed', null); ins('sold', 20); ins('ordered', null); ins('returned', null);
      db.run("INSERT INTO watchlist (name_key, name, added_at) VALUES ('karte', 'Karte', ?)", [now]);
      migrate(db, join(dir, 'backups'));
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM inventory_v20_legacy')?.n, 4);
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM purchase_orders')?.n, 4);
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stock_lots')?.n, 2);
      assert.equal(db.get<{ n: number }>('SELECT SUM(qty_on_hand) AS n FROM stock_lots')?.n, 2);
      assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sales_orders WHERE status = 'completed'")?.n, 1);
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM watchlist')?.n, 1, 'Watchlist bleibt erhalten');
      const s = settings();
      const res = getOrder(db, s, db.get<{ id: number }>('SELECT id FROM sales_orders')!.id).result!;
      // 2 × 20 − 1 Gebühr − 0,5 Porto − (2 × 10 + 2) = 16,50 – identisch zur Rechnung in 2.0
      assert.equal(res.contribution, 16.5);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
