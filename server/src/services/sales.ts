/**
 * Verkaufsaufträge & Versand.
 * Ablauf: NEU → GEPRÜFT (Zahlung bestätigt) → PICKLISTE → GEPACKT → VERSENDET → ABGESCHLOSSEN
 * Sonderstatus: STORNIERT (gibt Reservierungen frei), RETOURNIERT, PROBLEM (z. B. fehlende Karte).
 * Beim Anlegen werden die Karten sofort reserviert – eine reservierte oder verkaufte Karte ist nie
 * für einen zweiten Auftrag verfügbar. Doppelte Aufträge (Plattform + Auftragsnummer) werden abgewiesen.
 */
import { nowIso, type Db } from '../db/database.ts';
import type { AppSettings } from '../domain/settings.ts';
import { orderResult, type OrderResult, type SoldUnitGroup, type VatTreatment } from '../analytics/accounting.ts';
import { ApiError } from '../api/http.ts';
import { lotCode, movement, releaseAllocation, reserveForLine, returnAllocation, shipAllocation } from './stock.ts';
import { getProductByExternal } from './products.ts';

export const ORDER_STATUSES = ['new', 'checked', 'picking', 'packed', 'shipped', 'completed', 'cancelled', 'returned', 'problem'] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];
export const ACTIVE_STATUSES: OrderStatus[] = ['new', 'checked', 'picking', 'packed', 'problem'];

export interface OrderLineInput {
  productId?: number | null; productExternalId?: number | null; name?: string; setName?: string | null; finish?: string;
  condition?: string | null; language?: string | null; qty: number; unitPrice: number; lotId?: number | null;
}
export interface OrderInput {
  platform?: string; externalOrderId?: string | null; buyer?: string | null; buyerCountry?: string | null; shipAddress?: string | null;
  orderedAt?: string | null; shippingCharged?: number; priority?: number; paymentReceived?: boolean; notes?: string | null; lines: OrderLineInput[];
}

interface OrderRow {
  id: number; platform: string; external_order_id: string | null; buyer: string | null; buyer_country: string | null; ship_address: string | null;
  status: OrderStatus; payment_status: string; priority: number; shipping_charged: number; shipping_cost: number | null; packaging_cost: number | null;
  platform_fee: number | null; payment_fee: number | null; other_costs: number | null; refund_amount: number; carrier: string | null; tracking_number: string | null;
  ordered_at: string; paid_at: string | null; shipped_at: string | null; completed_at: string | null; status_before_problem: OrderStatus | null;
  problem_note: string | null; notes: string | null; archived: number; created_at: string; updated_at: string;
}
interface LineRow { id: number; order_id: number; product_id: number | null; name: string; set_name: string | null; finish: string; condition: string | null; language: string | null; qty: number; unit_price: number; missing_qty: number; returned_qty: number }
interface AllocRow { id: number; line_id: number; lot_id: number; qty: number; status: string; returned_qty: number; unit_cost: number; unit_alloc: number }

function getOrderRow(db: Db, id: number): OrderRow {
  const r = db.get<OrderRow>('SELECT * FROM sales_orders WHERE id = ?', [id]);
  if (!r) throw new ApiError(404, `Auftrag #${id} nicht gefunden`);
  return r;
}

function validateOrder(i: OrderInput) {
  if (!Array.isArray(i.lines) || !i.lines.length) throw new ApiError(400, 'Mindestens eine Position erforderlich');
  i.lines.forEach((l, n) => {
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new ApiError(400, `Position ${n + 1}: Menge muss ≥ 1 sein`);
    if (typeof l.unitPrice !== 'number' || !(l.unitPrice >= 0)) throw new ApiError(400, `Position ${n + 1}: Preis fehlt`);
    if (l.productId == null && l.productExternalId == null && !l.name?.trim() && l.lotId == null) throw new ApiError(400, `Position ${n + 1}: Karte fehlt`);
  });
  if (i.shippingCharged != null && !(i.shippingCharged >= 0)) throw new ApiError(400, 'Versandkosten (Käufer) müssen ≥ 0 sein');
  if (i.orderedAt && !Number.isFinite(Date.parse(i.orderedAt))) throw new ApiError(400, 'Bestelldatum ungültig');
}

/** Auftrag anlegen und alle Positionen sofort reservieren (alles oder nichts). */
export function createOrder(db: Db, i: OrderInput): number {
  validateOrder(i);
  const platform = (i.platform ?? 'cardmarket').trim().toLowerCase();
  const ext = i.externalOrderId?.trim() || null;
  if (ext && db.get('SELECT 1 FROM sales_orders WHERE platform = ? AND external_order_id = ?', [platform, ext])) {
    throw new ApiError(409, `Auftrag ${platform} #${ext} existiert bereits (Dublette)`);
  }
  return db.tx(() => {
    const now = nowIso();
    const paid = i.paymentReceived === true;
    const id = db.run(`INSERT INTO sales_orders (platform, external_order_id, buyer, buyer_country, ship_address, status, payment_status, priority,
        shipping_charged, ordered_at, paid_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [platform, ext, i.buyer ?? null, i.buyerCountry ?? null, i.shipAddress ?? null, paid ? 'received' : 'open', i.priority ?? 0,
        i.shippingCharged ?? 0, i.orderedAt ?? now, paid ? now : null, i.notes ?? null, now, now]).lastInsertRowid;
    for (const l of i.lines) addLine(db, id, l);
    return id;
  });
}

function addLine(db: Db, orderId: number, l: OrderLineInput): void {
  let productId = l.productId ?? null;
  let name = l.name ?? '', setName = l.setName ?? null, finish = l.finish ?? 'nonfoil', condition = l.condition || null, language = l.language || null;
  if (l.lotId != null) {
    const lot = db.get<{ product_id: number | null; name: string; set_name: string | null; finish: string; condition: string | null; language: string | null; ownership: string }>(
      'SELECT product_id, name, set_name, finish, condition, language, ownership FROM stock_lots WHERE id = ?', [l.lotId]);
    if (!lot) throw new ApiError(404, `Charge ${lotCode(l.lotId)} nicht gefunden`);
    if (lot.ownership !== 'business') throw new ApiError(409, `Charge ${lotCode(l.lotId)} ist Privatbestand und nicht verkäuflich`);
    productId = lot.product_id; name = lot.name; setName = lot.set_name; finish = lot.finish; condition = lot.condition; language = lot.language;
  } else if (productId == null && l.productExternalId != null) {
    const p = getProductByExternal(db, l.productExternalId);
    if (!p) throw new ApiError(404, `Cardmarket-Produkt ${l.productExternalId} unbekannt`);
    productId = p.id; name ||= p.name; setName ??= p.setName;
  } else if (productId != null && !name) {
    const p = db.get<{ name: string; set_name: string | null }>('SELECT name, set_name FROM products WHERE id = ?', [productId]);
    if (!p) throw new ApiError(404, `Produkt ${productId} nicht gefunden`);
    name = p.name; setName ??= p.set_name;
  }
  const lineId = db.run(`INSERT INTO sales_order_lines (order_id, product_id, name, set_name, finish, condition, language, qty, unit_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [orderId, productId, name, setName, finish, condition, language, l.qty, l.unitPrice]).lastInsertRowid;
  reserveForLine(db, lineId, { productId, name, setName, finish, condition, language }, l.qty, l.lotId ?? null);
}

const NEXT: Record<OrderStatus, OrderStatus[]> = {
  new: ['checked', 'cancelled', 'problem'],
  checked: ['picking', 'packed', 'cancelled', 'problem'],
  picking: ['packed', 'cancelled', 'problem'],
  packed: ['shipped', 'cancelled', 'problem'],
  shipped: ['completed', 'problem'],
  completed: [],
  cancelled: [],
  returned: [],
  problem: ['cancelled'],
};

export interface StatusInput {
  status: OrderStatus; paymentReceived?: boolean; shippingCost?: number | null; packagingCost?: number | null; platformFee?: number | null;
  paymentFee?: number | null; otherCosts?: number | null; carrier?: string | null; trackingNumber?: string | null; note?: string | null; refund?: number | null;
}

export function setOrderStatus(db: Db, id: number, i: StatusInput): void {
  const o = getOrderRow(db, id);
  if (!ORDER_STATUSES.includes(i.status)) throw new ApiError(400, 'Unbekannter Status');
  const allowed = NEXT[o.status].includes(i.status);
  if (!allowed) throw new ApiError(409, `Statuswechsel ${o.status} → ${i.status} nicht erlaubt`);
  const now = nowIso();
  db.tx(() => {
    if (i.paymentReceived && o.payment_status === 'open') db.run("UPDATE sales_orders SET payment_status = 'received', paid_at = ? WHERE id = ?", [now, id]);
    const paid = i.paymentReceived || o.payment_status === 'received';
    if (i.status === 'checked' && !paid) throw new ApiError(409, 'Zahlungseingang noch nicht bestätigt');
    if (['picking', 'packed', 'shipped'].includes(i.status)) {
      const missing = db.get<{ n: number }>('SELECT COALESCE(SUM(missing_qty), 0) AS n FROM sales_order_lines WHERE order_id = ?', [id])?.n ?? 0;
      if (missing > 0) throw new ApiError(409, `${missing} fehlende Karte(n) – erst nachreservieren oder Position kürzen`);
    }
    if (i.status === 'shipped') {
      const vals = { shippingCost: i.shippingCost ?? o.shipping_cost, packagingCost: i.packagingCost ?? o.packaging_cost, platformFee: i.platformFee ?? o.platform_fee };
      const miss = Object.entries(vals).filter(([, v]) => v == null).map(([k]) => k);
      if (miss.length) throw new ApiError(400, `Für den Versand bitte angeben: ${miss.join(', ')} (keine stillschweigenden Standardwerte)`);
      for (const [k, v] of Object.entries({ ...vals, paymentFee: i.paymentFee, otherCosts: i.otherCosts })) if (v != null && !((v as number) >= 0)) throw new ApiError(400, `${k} muss ≥ 0 sein`);
      for (const a of db.all<AllocRow>(`SELECT a.* FROM sales_allocations a JOIN sales_order_lines l ON l.id = a.line_id WHERE l.order_id = ? AND a.status = 'reserved'`, [id])) {
        shipAllocation(db, a, id);
      }
      db.run(`UPDATE sales_orders SET shipping_cost = ?, packaging_cost = ?, platform_fee = ?, payment_fee = COALESCE(?, payment_fee),
          other_costs = COALESCE(?, other_costs), carrier = COALESCE(?, carrier), tracking_number = COALESCE(?, tracking_number), shipped_at = ? WHERE id = ?`,
        [vals.shippingCost, vals.packagingCost, vals.platformFee, i.paymentFee ?? null, i.otherCosts ?? null, i.carrier ?? null, i.trackingNumber ?? null, now, id]);
    }
    if (i.status === 'completed' && !paid) throw new ApiError(409, 'Abschluss erst nach Zahlungseingang');
    if (i.status === 'cancelled') {
      if (o.shipped_at) throw new ApiError(409, 'Bereits versendet – bitte Rücksendung bzw. Verlust (Rücksendung ohne Einlagerung) erfassen');
      for (const a of db.all<AllocRow>(`SELECT a.* FROM sales_allocations a JOIN sales_order_lines l ON l.id = a.line_id WHERE l.order_id = ? AND a.status = 'reserved'`, [id])) {
        releaseAllocation(db, a, a.qty, 'Storno');
      }
      if (o.payment_status === 'received') {
        if (i.refund == null) throw new ApiError(400, 'Bezahlter Auftrag: erstatteten Betrag angeben');
        db.run("UPDATE sales_orders SET payment_status = 'refunded', refund_amount = ? WHERE id = ?", [i.refund, id]);
      }
    }
    db.run(`UPDATE sales_orders SET status = ?, status_before_problem = CASE WHEN ? = 'problem' THEN ? ELSE status_before_problem END,
        problem_note = CASE WHEN ? = 'problem' THEN ? ELSE problem_note END, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
        updated_at = ? WHERE id = ?`, [i.status, i.status, o.status, i.status, i.note ?? null, i.status, now, now, id]);
  });
}

/** Problem gelöst → zurück in den vorherigen Status. */
export function resolveProblem(db: Db, id: number): void {
  const o = getOrderRow(db, id);
  if (o.status !== 'problem') throw new ApiError(409, 'Auftrag hat keinen Problemstatus');
  const missing = db.get<{ n: number }>('SELECT COALESCE(SUM(missing_qty), 0) AS n FROM sales_order_lines WHERE order_id = ?', [id])?.n ?? 0;
  if (missing > 0) throw new ApiError(409, 'Es fehlen noch Karten – nachreservieren oder Position kürzen');
  db.run('UPDATE sales_orders SET status = ?, problem_note = NULL, updated_at = ? WHERE id = ?', [o.status_before_problem ?? 'new', nowIso(), id]);
}

/** Karte beim Kommissionieren nicht auffindbar: Reservierung lösen, Bestand ausbuchen, Auftrag auf PROBLEM. */
export function reportMissing(db: Db, lineId: number, qty: number, lotId?: number | null): void {
  const line = db.get<LineRow>('SELECT * FROM sales_order_lines WHERE id = ?', [lineId]);
  if (!line) throw new ApiError(404, 'Position nicht gefunden');
  const o = getOrderRow(db, line.order_id);
  if (!['new', 'checked', 'picking', 'packed', 'problem'].includes(o.status)) throw new ApiError(409, 'Nur vor dem Versand möglich');
  const allocs = db.all<AllocRow>("SELECT * FROM sales_allocations WHERE line_id = ? AND status = 'reserved' ORDER BY id", [lineId])
    .filter(a => lotId == null || a.lot_id === lotId);
  const reserved = allocs.reduce((a, x) => a + x.qty, 0);
  if (!Number.isInteger(qty) || qty < 1 || qty > reserved) throw new ApiError(400, `Menge 1–${reserved}`);
  db.tx(() => {
    let left = qty;
    for (const a of allocs) {
      if (left <= 0) break;
      const n = Math.min(left, a.qty);
      releaseAllocation(db, a, n, 'fehlt beim Kommissionieren');
      db.run('UPDATE stock_lots SET qty_on_hand = qty_on_hand - ?, updated_at = ? WHERE id = ?', [n, nowIso(), a.lot_id]);
      movement(db, a.lot_id, 'writeoff', -n, { type: 'sales_order', id: o.id }, 'Karte fehlt (Inventurdifferenz)');
      left -= n;
    }
    db.run('UPDATE sales_order_lines SET missing_qty = missing_qty + ? WHERE id = ?', [qty, lineId]);
    if (o.status !== 'problem') {
      db.run("UPDATE sales_orders SET status = 'problem', status_before_problem = ?, problem_note = ?, updated_at = ? WHERE id = ?",
        [o.status, `${qty}× ${line.name} fehlt`, nowIso(), o.id]);
    }
  });
}

/** Fehlmenge auflösen: aus anderer Charge nachreservieren oder Position kürzen (mit Erstattung). */
export function resolveMissing(db: Db, lineId: number, mode: 'reallocate' | 'drop'): void {
  const line = db.get<LineRow>('SELECT * FROM sales_order_lines WHERE id = ?', [lineId]);
  if (!line) throw new ApiError(404, 'Position nicht gefunden');
  if (line.missing_qty < 1) throw new ApiError(409, 'Keine Fehlmenge');
  db.tx(() => {
    if (mode === 'reallocate') {
      reserveForLine(db, lineId, { productId: line.product_id, name: line.name, setName: line.set_name, finish: line.finish, condition: line.condition, language: line.language }, line.missing_qty);
    } else {
      const o = getOrderRow(db, line.order_id);
      const refund = line.unit_price * line.missing_qty;
      if (line.qty - line.missing_qty < 1) {
        const others = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sales_order_lines WHERE order_id = ? AND id != ?', [line.order_id, lineId])?.n ?? 0;
        if (!others) throw new ApiError(409, 'Letzte Position – bitte den Auftrag stornieren');
        db.run('DELETE FROM sales_order_lines WHERE id = ?', [lineId]);
      } else {
        db.run('UPDATE sales_order_lines SET qty = qty - missing_qty WHERE id = ?', [lineId]);
      }
      // Die gekürzte Menge senkt den Auftragswert bereits – deshalb KEIN zusätzlicher Erstattungsbetrag (sonst doppelt gezählt).
      const note = `Position gekürzt: ${line.missing_qty}× ${line.name}` + (o.payment_status === 'received' ? ` – ${refund.toFixed(2)} € an Käufer erstatten` : '');
      db.run("UPDATE sales_orders SET notes = COALESCE(notes || char(10), '') || ? WHERE id = ?", [note, o.id]);
    }
    db.run('UPDATE sales_order_lines SET missing_qty = 0 WHERE id = ?', [lineId]);
  });
}

/** Rücksendung (teilweise oder vollständig) nach dem Versand. */
export function returnItems(db: Db, orderId: number, items: { lineId: number; qty: number; restock: boolean }[], refund: number): void {
  const o = getOrderRow(db, orderId);
  if (!['shipped', 'completed', 'problem'].includes(o.status) || !o.shipped_at) throw new ApiError(409, 'Rücksendung nur für versendete Aufträge');
  if (!(refund >= 0)) throw new ApiError(400, 'Erstattung muss ≥ 0 sein');
  if (!items.length) throw new ApiError(400, 'Keine Positionen');
  db.tx(() => {
    for (const it of items) {
      const line = db.get<LineRow>('SELECT * FROM sales_order_lines WHERE id = ? AND order_id = ?', [it.lineId, orderId]);
      if (!line) throw new ApiError(404, 'Position gehört nicht zu diesem Auftrag');
      let left = it.qty;
      for (const a of db.all<AllocRow>("SELECT * FROM sales_allocations WHERE line_id = ? AND status IN ('shipped','returned') AND returned_qty < qty ORDER BY id", [line.id])) {
        if (left <= 0) break;
        const n = Math.min(left, a.qty - a.returned_qty);
        returnAllocation(db, a, n, it.restock, orderId);
        left -= n;
      }
      if (left > 0) throw new ApiError(400, `${line.name}: höchstens ${it.qty - left} Exemplar(e) rückgabefähig`);
      db.run('UPDATE sales_order_lines SET returned_qty = returned_qty + ? WHERE id = ?', [it.qty, line.id]);
    }
    const open = db.get<{ n: number }>('SELECT COALESCE(SUM(qty - returned_qty), 0) AS n FROM sales_order_lines WHERE order_id = ?', [orderId])?.n ?? 0;
    db.run(`UPDATE sales_orders SET refund_amount = refund_amount + ?, status = CASE WHEN ? = 0 THEN 'returned' ELSE status END,
        payment_status = CASE WHEN ? = 0 AND payment_status = 'received' THEN 'refunded' ELSE payment_status END, updated_at = ? WHERE id = ?`,
      [refund, open, open, nowIso(), orderId]);
  });
}

export function updateOrderDetails(db: Db, id: number, i: Partial<StatusInput> & { buyer?: string | null; shipAddress?: string | null; notes?: string | null; priority?: number; shippingCharged?: number; paymentReceived?: boolean }): void {
  getOrderRow(db, id);
  for (const k of ['shippingCost', 'packagingCost', 'platformFee', 'paymentFee', 'otherCosts', 'shippingCharged'] as const) {
    const v = (i as Record<string, unknown>)[k];
    if (v != null && !((v as number) >= 0)) throw new ApiError(400, `${k} muss ≥ 0 sein`);
  }
  db.run(`UPDATE sales_orders SET buyer = COALESCE(?, buyer), ship_address = COALESCE(?, ship_address), notes = COALESCE(?, notes), priority = COALESCE(?, priority),
      shipping_charged = COALESCE(?, shipping_charged), shipping_cost = COALESCE(?, shipping_cost), packaging_cost = COALESCE(?, packaging_cost),
      platform_fee = COALESCE(?, platform_fee), payment_fee = COALESCE(?, payment_fee), other_costs = COALESCE(?, other_costs),
      carrier = COALESCE(?, carrier), tracking_number = COALESCE(?, tracking_number),
      payment_status = CASE WHEN ? = 1 AND payment_status = 'open' THEN 'received' ELSE payment_status END,
      paid_at = CASE WHEN ? = 1 AND paid_at IS NULL THEN ? ELSE paid_at END, updated_at = ? WHERE id = ?`,
    [i.buyer ?? null, i.shipAddress ?? null, i.notes ?? null, i.priority ?? null, i.shippingCharged ?? null, i.shippingCost ?? null, i.packagingCost ?? null,
      i.platformFee ?? null, i.paymentFee ?? null, i.otherCosts ?? null, i.carrier ?? null, i.trackingNumber ?? null,
      i.paymentReceived ? 1 : 0, i.paymentReceived ? 1 : 0, nowIso(), nowIso(), id]);
}

export function archiveOrders(db: Db, s: AppSettings, ids?: number[]): number {
  if (ids?.length) {
    return db.run(`UPDATE sales_orders SET archived = 1 WHERE id IN (${ids.map(() => '?').join(',')}) AND status IN ('completed','cancelled','returned')`, ids).changes;
  }
  const before = new Date(Date.now() - s.business.archiveAfterDays * 864e5).toISOString();
  return db.run("UPDATE sales_orders SET archived = 1 WHERE archived = 0 AND status IN ('completed','cancelled','returned') AND updated_at < ?", [before]).changes;
}

// ---------------------------------------------------------------------------- Ergebnis je Auftrag

export function soldGroups(db: Db, orderId: number): SoldUnitGroup[] {
  return db.all<AllocRow & { unit_price: number; vat_treatment: string; vat_rate_pct: number; restocked_qty: number }>(`
    SELECT a.*, l.unit_price, s.vat_treatment, s.vat_rate_pct FROM sales_allocations a
    JOIN sales_order_lines l ON l.id = a.line_id JOIN stock_lots s ON s.id = a.lot_id
    WHERE l.order_id = ? AND a.status IN ('shipped','returned') ORDER BY a.id`, [orderId])
    .map(a => ({ qty: a.qty, costQty: a.qty - a.restocked_qty, unitPrice: a.unit_price, unitCost: a.unit_cost, unitAlloc: a.unit_alloc, treatment: a.vat_treatment as VatTreatment, vatRatePct: a.vat_rate_pct }));
}

export function computeOrderResult(db: Db, s: AppSettings, o: OrderRow): OrderResult | null {
  if (!o.shipped_at) return null;
  const groups = soldGroups(db, o.id);
  return orderResult(groups, {
    shippingCharged: o.shipping_charged, shippingCost: o.shipping_cost ?? 0, packagingCost: o.packaging_cost ?? 0, platformFee: o.platform_fee ?? 0,
    paymentFee: o.payment_fee ?? 0, otherCosts: o.other_costs ?? 0, refund: o.refund_amount,
  }, s);
}

function toOrderView(db: Db, s: AppSettings, o: OrderRow, withLines: boolean) {
  const lines = db.all<LineRow>('SELECT * FROM sales_order_lines WHERE order_id = ? ORDER BY id', [o.id]);
  const units = lines.reduce((a, l) => a + l.qty, 0);
  const itemsValue = lines.reduce((a, l) => a + l.qty * l.unit_price, 0);
  const ageDays = (Date.now() - Date.parse(o.ordered_at)) / 864e5;
  const overdue = ACTIVE_STATUSES.includes(o.status) && ageDays >= s.business.overdueShipDays;
  return {
    id: o.id, platform: o.platform, externalOrderId: o.external_order_id, buyer: o.buyer, buyerCountry: o.buyer_country, shipAddress: o.ship_address,
    status: o.status, paymentStatus: o.payment_status, priority: o.priority, overdue, shippingCharged: o.shipping_charged, shippingCost: o.shipping_cost,
    packagingCost: o.packaging_cost, platformFee: o.platform_fee, paymentFee: o.payment_fee, otherCosts: o.other_costs, refundAmount: o.refund_amount,
    carrier: o.carrier, trackingNumber: o.tracking_number, orderedAt: o.ordered_at, paidAt: o.paid_at, shippedAt: o.shipped_at, completedAt: o.completed_at,
    problemNote: o.problem_note, notes: o.notes, archived: !!o.archived, units, itemsValue: Math.round(itemsValue * 100) / 100,
    missing: lines.reduce((a, l) => a + l.missing_qty, 0),
    result: computeOrderResult(db, s, o),
    lines: withLines ? lines.map(l => ({
      id: l.id, productId: l.product_id, name: l.name, setName: l.set_name, finish: l.finish, condition: l.condition, language: l.language,
      qty: l.qty, unitPrice: l.unit_price, missingQty: l.missing_qty, returnedQty: l.returned_qty,
      allocations: db.all<AllocRow & { code: string; warehouse: string | null }>(`
        SELECT a.*, loc.code, loc.warehouse FROM sales_allocations a JOIN stock_lots s ON s.id = a.lot_id LEFT JOIN locations loc ON loc.id = s.location_id
        WHERE a.line_id = ? AND a.status != 'released' ORDER BY a.id`, [l.id])
        .map(a => ({ id: a.id, lotId: a.lot_id, lotCode: lotCode(a.lot_id), qty: a.qty, status: a.status, returnedQty: a.returned_qty, location: a.code, warehouse: a.warehouse })),
    })) : undefined,
  };
}

export function getOrder(db: Db, s: AppSettings, id: number) {
  return toOrderView(db, s, getOrderRow(db, id), true);
}

export function listOrders(db: Db, s: AppSettings, opts: { status?: string; active?: boolean; archived?: boolean; q?: string; limit?: number; offset?: number } = {}) {
  const where: string[] = [];
  const p: (string | number)[] = [];
  where.push('archived = ?'); p.push(opts.archived ? 1 : 0);
  if (opts.status) { where.push('status = ?'); p.push(opts.status); }
  if (opts.active) where.push(`status IN (${ACTIVE_STATUSES.map(x => `'${x}'`).join(',')})`);
  if (opts.q) { where.push('(external_order_id LIKE ? OR buyer LIKE ? OR id IN (SELECT order_id FROM sales_order_lines WHERE name LIKE ?))'); p.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`); }
  const w = where.join(' AND ');
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sales_orders WHERE ${w}`, p)?.n ?? 0;
  const rows = db.all<OrderRow>(`SELECT * FROM sales_orders WHERE ${w} ORDER BY priority DESC, ordered_at ASC, id ASC LIMIT ? OFFSET ?`,
    [...p, Math.min(opts.limit ?? 200, 1000), opts.offset ?? 0]);
  return { total, items: rows.map(o => toOrderView(db, s, o, true)) };
}

// ---------------------------------------------------------------------------- Pickliste

/** Sammel-Pickliste über mehrere Aufträge, sortiert nach Lager und Lagerplatz. Setzt die Aufträge auf PICKLISTE. */
export function buildPicklist(db: Db, orderIds: number[], markPicking: boolean) {
  if (!orderIds.length) throw new ApiError(400, 'Keine Aufträge ausgewählt');
  const rows = db.all<{ order_id: number; external_order_id: string | null; status: string; lot_id: number; qty: number; name: string; set_name: string | null; finish: string; condition: string | null; language: string | null; code: string | null; warehouse: string | null; line_id: number }>(`
    SELECT o.id AS order_id, o.external_order_id, o.status, a.lot_id, a.qty, s.name, s.set_name, s.finish, s.condition, s.language, loc.code, loc.warehouse, a.line_id
    FROM sales_allocations a JOIN sales_order_lines l ON l.id = a.line_id JOIN sales_orders o ON o.id = l.order_id
    JOIN stock_lots s ON s.id = a.lot_id LEFT JOIN locations loc ON loc.id = s.location_id
    WHERE a.status = 'reserved' AND o.id IN (${orderIds.map(() => '?').join(',')})
    ORDER BY loc.warehouse IS NULL, loc.warehouse, loc.code IS NULL, loc.code, s.name COLLATE NOCASE`, orderIds);
  const notReady = db.all<{ id: number; status: string }>(`SELECT id, status FROM sales_orders WHERE id IN (${orderIds.map(() => '?').join(',')}) AND status NOT IN ('checked','picking')`, orderIds);
  if (markPicking) {
    db.run(`UPDATE sales_orders SET status = 'picking', updated_at = ? WHERE status = 'checked' AND id IN (${orderIds.map(() => '?').join(',')})`, [nowIso(), ...orderIds]);
  }
  const byLot = new Map<number, { lotId: number; lotCode: string; location: string | null; warehouse: string | null; name: string; setName: string | null; finish: string; condition: string | null; language: string | null; qty: number; orders: { orderId: number; ref: string; qty: number; lineId: number }[] }>();
  for (const r of rows) {
    const e = byLot.get(r.lot_id) ?? { lotId: r.lot_id, lotCode: lotCode(r.lot_id), location: r.code, warehouse: r.warehouse, name: r.name, setName: r.set_name, finish: r.finish, condition: r.condition, language: r.language, qty: 0, orders: [] };
    e.qty += r.qty;
    e.orders.push({ orderId: r.order_id, ref: r.external_order_id ?? `#${r.order_id}`, qty: r.qty, lineId: r.line_id });
    byLot.set(r.lot_id, e);
  }
  return { createdAt: nowIso(), orders: orderIds.length, items: [...byLot.values()], warnings: notReady.map(o => `Auftrag #${o.id} hat Status "${o.status}" (nicht geprüft) und ist nur informativ enthalten`) };
}

// ---------------------------------------------------------------------------- CSV-Import

/**
 * Standardisiertes CSV (Trennzeichen ; oder ,): order_id;platform;buyer;country;ordered_at;paid;shipping_charged;idProduct;name;set;condition;language;foil;qty;price
 * Mehrere Zeilen mit derselben order_id = ein Auftrag mit mehreren Positionen. Jeder Auftrag wird einzeln
 * (alles oder nichts) angelegt; Dubletten und fehlerhafte Aufträge werden mit Grund gemeldet.
 */
export function importOrdersCsv(db: Db, text: string) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new ApiError(400, 'CSV braucht Kopfzeile und Daten');
  const sep = lines[0].includes(';') ? ';' : ',';
  const split = (l: string) => {
    const out: string[] = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map(x => x.trim());
  };
  const head = split(lines[0]).map(h => h.toLowerCase());
  const col = (...n: string[]) => head.findIndex(h => n.includes(h));
  const ix = {
    order: col('order_id', 'auftrag', 'bestellung', 'order'), platform: col('platform', 'plattform'), buyer: col('buyer', 'käufer', 'kaeufer'),
    country: col('country', 'land'), date: col('ordered_at', 'datum', 'date'), paid: col('paid', 'bezahlt'), ship: col('shipping_charged', 'porto', 'versand'),
    pid: col('idproduct', 'product_id', 'cardmarket_id'), name: col('name', 'karte'), set: col('set', 'edition', 'expansion'), cond: col('condition', 'zustand'),
    lang: col('language', 'sprache'), foil: col('foil', 'finish'), qty: col('qty', 'menge', 'anzahl', 'amount'), price: col('price', 'preis'),
  };
  if (ix.order === -1 || ix.price === -1 || (ix.pid === -1 && ix.name === -1)) throw new ApiError(400, 'Pflichtspalten: order_id, price und idProduct oder name');
  const num = (s: string) => Number(s.replace(/[€\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  const groups = new Map<string, { rows: number[]; input: OrderInput; errors: string[] }>();
  lines.slice(1).forEach((l, n) => {
    const c = split(l);
    const g = (k: number) => (k === -1 ? '' : c[k] ?? '');
    const id = g(ix.order);
    const rowNo = n + 2;
    if (!id) { groups.set(`__row${rowNo}`, { rows: [rowNo], input: { lines: [] }, errors: ['order_id fehlt'] }); return; }
    let e = groups.get(id);
    if (!e) {
      const ship = g(ix.ship) ? num(g(ix.ship)) : 0;
      e = { rows: [], errors: [], input: {
        externalOrderId: id, platform: g(ix.platform) || 'cardmarket', buyer: g(ix.buyer) || null, buyerCountry: g(ix.country) || null,
        orderedAt: g(ix.date) || null, paymentReceived: ['1', 'ja', 'true', 'yes', 'x'].includes(g(ix.paid).toLowerCase()), shippingCharged: ship, lines: [],
      } };
      if (!Number.isFinite(ship) || ship < 0) e.errors.push(`Zeile ${rowNo}: Porto ungültig`);
      groups.set(id, e);
    }
    e.rows.push(rowNo);
    const price = num(g(ix.price));
    const qty = g(ix.qty) ? Number(g(ix.qty)) : 1;
    if (!Number.isFinite(price) || price < 0) { e.errors.push(`Zeile ${rowNo}: Preis "${g(ix.price)}" ungültig`); return; }
    if (!Number.isInteger(qty) || qty < 1) { e.errors.push(`Zeile ${rowNo}: Menge "${g(ix.qty)}" ungültig`); return; }
    const foil = ['1', 'ja', 'true', 'yes', 'foil'].includes(g(ix.foil).toLowerCase());
    e.input.lines.push({
      productExternalId: g(ix.pid) ? Number(g(ix.pid)) : null, name: g(ix.name) || undefined, setName: g(ix.set) || null,
      condition: g(ix.cond).toUpperCase() || null, language: g(ix.lang).toLowerCase() || null, finish: foil ? 'foil' : 'nonfoil', qty, unitPrice: price,
    });
  });
  const created: { orderId: number; externalOrderId: string }[] = [];
  const duplicates: string[] = [];
  const failed: { externalOrderId: string; rows: number[]; error: string }[] = [];
  for (const [ext, g] of groups) {
    if (g.errors.length) { failed.push({ externalOrderId: ext, rows: g.rows, error: g.errors.join('; ') }); continue; }
    try {
      created.push({ orderId: createOrder(db, g.input), externalOrderId: ext });
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409 && /Dublette/.test(err.message)) duplicates.push(ext);
      else failed.push({ externalOrderId: ext, rows: g.rows, error: err.message });
    }
  }
  return { created, duplicates, failed };
}
