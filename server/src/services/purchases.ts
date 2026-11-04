/**
 * Einkauf: geplant (Kapital reserviert) → bestellt → bezahlt → (teil-)geliefert → eingelagert.
 * Einkaufsnebenkosten (Porto, Sonstiges) werden centgenau nach Warenwert auf die Positionen verteilt
 * und beim Wareneingang als zugeordnete Kosten in die Chargen übernommen.
 */
import { nowIso, type Db } from '../db/database.ts';
import type { AppSettings } from '../domain/settings.ts';
import { allocateCents } from '../analytics/accounting.ts';
import { ApiError } from '../api/http.ts';
import { createLot, lotCode } from './stock.ts';

export const PO_STATUSES = ['planned', 'ordered', 'paid', 'partially_received', 'received', 'cancelled', 'problem', 'returned'] as const;
export type PoStatus = typeof PO_STATUSES[number];

export interface PurchaseLineInput {
  productId?: number | null; name?: string; setName?: string | null; finish?: string; condition?: string | null; language?: string | null;
  qty: number; unitPrice: number; decisionId?: number | null; opportunityKey?: string | null;
}
export interface PurchaseInput {
  supplier?: string | null; platform?: string; externalRef?: string | null; status?: 'planned' | 'ordered' | 'paid';
  vatTreatment?: 'none' | 'vat_invoice' | 'margin_scheme'; vatRatePct?: number; shippingCost?: number; otherCosts?: number;
  orderedAt?: string | null; notes?: string | null; lines: PurchaseLineInput[];
}

function validate(i: PurchaseInput) {
  if (!Array.isArray(i.lines) || !i.lines.length) throw new ApiError(400, 'Mindestens eine Position erforderlich');
  for (const [n, l] of i.lines.entries()) {
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new ApiError(400, `Position ${n + 1}: Menge muss ≥ 1 sein`);
    if (typeof l.unitPrice !== 'number' || !(l.unitPrice >= 0)) throw new ApiError(400, `Position ${n + 1}: Stückpreis fehlt`);
    if (l.productId == null && !l.name?.trim()) throw new ApiError(400, `Position ${n + 1}: Produkt oder Name erforderlich`);
  }
  for (const k of ['shippingCost', 'otherCosts'] as const) if (i[k] != null && !(i[k]! >= 0)) throw new ApiError(400, `${k} muss ≥ 0 sein`);
  if (i.vatTreatment && !['none', 'vat_invoice', 'margin_scheme'].includes(i.vatTreatment)) throw new ApiError(400, 'vatTreatment: none | vat_invoice | margin_scheme');
  if (i.status && !['planned', 'ordered', 'paid'].includes(i.status)) throw new ApiError(400, 'Neuer Einkauf: Status planned, ordered oder paid');
}

export function createPurchase(db: Db, i: PurchaseInput): number {
  validate(i);
  return db.tx(() => {
    const now = nowIso();
    const status = i.status ?? 'planned';
    const ordered = status === 'planned' ? null : (i.orderedAt ?? now);
    const id = db.run(`INSERT INTO purchase_orders (supplier, platform, external_ref, status, vat_treatment, vat_rate_pct, shipping_cost, other_costs,
        ordered_at, paid_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [i.supplier ?? null, i.platform ?? 'cardmarket', i.externalRef ?? null, status, i.vatTreatment ?? 'none', i.vatRatePct ?? 19,
        i.shippingCost ?? 0, i.otherCosts ?? 0, ordered, status === 'paid' ? ordered : null, i.notes ?? null, now, now]).lastInsertRowid;
    for (const l of i.lines) {
      let name = l.name ?? '', setName = l.setName ?? null;
      if (l.productId != null) {
        const p = db.get<{ name: string; set_name: string | null }>('SELECT name, set_name FROM products WHERE id = ?', [l.productId]);
        if (!p) throw new ApiError(404, `Produkt ${l.productId} nicht gefunden`);
        name ||= p.name; setName ??= p.set_name;
      }
      db.run(`INSERT INTO purchase_lines (po_id, product_id, name, set_name, finish, condition, language, qty, unit_price, decision_id, opportunity_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, l.productId ?? null, name, setName, l.finish ?? 'nonfoil', l.condition || null, l.language || null, l.qty, l.unitPrice, l.decisionId ?? null, l.opportunityKey ?? null]);
    }
    return id;
  });
}

interface PoRow { id: number; status: PoStatus; shipping_cost: number; other_costs: number; vat_treatment: string; vat_rate_pct: number; paid_at: string | null; received_at: string | null; ordered_at: string | null }
interface LineRow { id: number; po_id: number; product_id: number | null; name: string; set_name: string | null; finish: string; condition: string | null; language: string | null; qty: number; unit_price: number; received_qty: number; decision_id: number | null }

function getPo(db: Db, id: number): PoRow {
  const r = db.get<PoRow>('SELECT * FROM purchase_orders WHERE id = ?', [id]);
  if (!r) throw new ApiError(404, `Einkauf #${id} nicht gefunden`);
  return r;
}

/** Nebenkosten je Position (Summe für die Positionsmenge). */
export function lineAllocations(db: Db, poId: number): Map<number, number> {
  const po = getPo(db, poId);
  const lines = db.all<LineRow>('SELECT * FROM purchase_lines WHERE po_id = ? ORDER BY id', [poId]);
  const shares = allocateCents(po.shipping_cost + po.other_costs, lines.map(l => l.unit_price * l.qty));
  return new Map(lines.map((l, i) => [l.id, shares[i]]));
}

const TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  planned: ['ordered', 'paid', 'cancelled'],
  ordered: ['paid', 'cancelled', 'problem'],
  paid: ['problem', 'cancelled', 'returned'],
  partially_received: ['problem', 'returned'],
  received: ['returned'],
  problem: ['ordered', 'paid', 'cancelled', 'returned'],
  cancelled: [],
  returned: [],
};

export function setPurchaseStatus(db: Db, id: number, status: PoStatus, opts: { note?: string | null; refund?: number | null; at?: string | null } = {}): void {
  const po = getPo(db, id);
  if (!TRANSITIONS[po.status].includes(status)) throw new ApiError(409, `Statuswechsel ${po.status} → ${status} nicht erlaubt`);
  const at = opts.at ?? nowIso();
  db.tx(() => {
    if (status === 'returned' || status === 'cancelled') {
      const received = db.get<{ n: number }>('SELECT COALESCE(SUM(received_qty), 0) AS n FROM purchase_lines WHERE po_id = ?', [id])?.n ?? 0;
      if (received > 0 && status === 'cancelled') throw new ApiError(409, 'Bereits eingelagerte Ware: bitte "Rückgabe an Verkäufer" verwenden');
      if (received > 0) {
        // Rückgabe an den Verkäufer: eingelagerte Exemplare müssen frei sein und werden ausgebucht.
        const lots = db.all<{ id: number; qty_on_hand: number; qty_reserved: number; qty_received: number }>(`
          SELECT s.id, s.qty_on_hand, s.qty_reserved, s.qty_received FROM stock_lots s JOIN purchase_lines l ON l.id = s.purchase_line_id WHERE l.po_id = ?`, [id]);
        for (const l of lots) {
          if (l.qty_reserved > 0 || l.qty_on_hand < l.qty_received) throw new ApiError(409, `Charge ${lotCode(l.id)} ist bereits (teil-)verkauft oder reserviert – Rückgabe nicht möglich`);
        }
        for (const l of lots) {
          db.run('UPDATE stock_lots SET qty_on_hand = 0, updated_at = ? WHERE id = ?', [at, l.id]);
          db.run("INSERT INTO stock_movements (lot_id, type, qty, ref_type, ref_id, note, created_at) VALUES (?, 'writeoff', ?, 'purchase_order', ?, 'Rückgabe an Verkäufer', ?)", [l.id, -l.qty_on_hand, id, at]);
        }
      }
      if (opts.refund != null) {
        if (!(opts.refund >= 0)) throw new ApiError(400, 'Erstattung muss ≥ 0 sein');
        db.run('UPDATE purchase_orders SET refund_amount = ? WHERE id = ?', [opts.refund, id]);
      } else if (po.paid_at) {
        throw new ApiError(400, 'Bezahlter Einkauf: bitte erstatteten Betrag angeben (0, falls nichts erstattet wurde)');
      }
    }
    db.run(`UPDATE purchase_orders SET status = ?, ordered_at = COALESCE(ordered_at, CASE WHEN ? IN ('ordered','paid') THEN ? END),
        paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, ?) ELSE paid_at END,
        problem_note = CASE WHEN ? = 'problem' THEN ? ELSE problem_note END, updated_at = ? WHERE id = ?`,
      [status, status, at, status, at, status, opts.note ?? null, nowIso(), id]);
  });
}

export function updatePurchaseCosts(db: Db, id: number, i: { shippingCost?: number; otherCosts?: number; supplier?: string | null; externalRef?: string | null; notes?: string | null; vatTreatment?: string }): void {
  const po = getPo(db, id);
  if (['cancelled', 'returned'].includes(po.status)) throw new ApiError(409, 'Abgeschlossener Einkauf kann nicht geändert werden');
  for (const k of ['shippingCost', 'otherCosts'] as const) if (i[k] != null && !(i[k]! >= 0)) throw new ApiError(400, `${k} muss ≥ 0 sein`);
  if (i.vatTreatment && !['none', 'vat_invoice', 'margin_scheme'].includes(i.vatTreatment)) throw new ApiError(400, 'vatTreatment ungültig');
  db.tx(() => {
    db.run(`UPDATE purchase_orders SET shipping_cost = COALESCE(?, shipping_cost), other_costs = COALESCE(?, other_costs), supplier = COALESCE(?, supplier),
      external_ref = COALESCE(?, external_ref), notes = COALESCE(?, notes), vat_treatment = COALESCE(?, vat_treatment), updated_at = ? WHERE id = ?`,
      [i.shippingCost ?? null, i.otherCosts ?? null, i.supplier ?? null, i.externalRef ?? null, i.notes ?? null, i.vatTreatment ?? null, nowIso(), id]);
    // Bereits eingelagerte Chargen erhalten die neu verteilten Nebenkosten (anteilig nach eingelagerter Menge).
    const alloc = lineAllocations(db, id);
    const lines = db.all<LineRow>('SELECT * FROM purchase_lines WHERE po_id = ?', [id]);
    for (const l of lines) {
      const perUnit = (alloc.get(l.id) ?? 0) / l.qty;
      db.run('UPDATE stock_lots SET allocated_cost_total = ROUND(? * qty_received, 2), vat_treatment = (SELECT vat_treatment FROM purchase_orders WHERE id = ?) WHERE purchase_line_id = ?',
        [perUnit, id, l.id]);
    }
  });
}

/** Wareneingang einer Position (auch Teillieferung). Erzeugt eine Charge mit Lagerplatz. */
export function receiveLine(db: Db, s: AppSettings, lineId: number, i: { qty: number; locationCode?: string | null; condition?: string | null; language?: string | null; at?: string | null }): number {
  const line = db.get<LineRow>('SELECT * FROM purchase_lines WHERE id = ?', [lineId]);
  if (!line) throw new ApiError(404, 'Position nicht gefunden');
  const po = getPo(db, line.po_id);
  if (['planned', 'cancelled', 'returned'].includes(po.status)) throw new ApiError(409, `Wareneingang bei Status "${po.status}" nicht möglich – zuerst als bestellt/bezahlt markieren`);
  if (!Number.isInteger(i.qty) || i.qty < 1) throw new ApiError(400, 'Menge muss ≥ 1 sein');
  if (line.received_qty + i.qty > line.qty) throw new ApiError(409, `Es sind nur noch ${line.qty - line.received_qty} Exemplar(e) offen`);
  return db.tx(() => {
    const perUnitAlloc = (lineAllocations(db, po.id).get(line.id) ?? 0) / line.qty;
    const lotId = createLot(db, s, {
      productId: line.product_id, name: line.name, setName: line.set_name, finish: line.finish,
      condition: i.condition ?? line.condition, language: i.language ?? line.language, qty: i.qty, unitCost: line.unit_price,
      allocatedCostTotal: Math.round(perUnitAlloc * i.qty * 100) / 100, acquiredAt: (po.ordered_at ?? nowIso()).slice(0, 10),
      locationCode: i.locationCode ?? null, vatTreatment: po.vat_treatment,
    }, line.id);
    db.run('UPDATE stock_lots SET vat_rate_pct = ? WHERE id = ?', [po.vat_rate_pct, lotId]);
    db.run('UPDATE purchase_lines SET received_qty = received_qty + ? WHERE id = ?', [i.qty, line.id]);
    const open = db.get<{ n: number }>('SELECT COALESCE(SUM(qty - received_qty), 0) AS n FROM purchase_lines WHERE po_id = ?', [po.id])?.n ?? 0;
    const at = i.at ?? nowIso();
    db.run(`UPDATE purchase_orders SET status = ?, received_at = CASE WHEN ? = 0 THEN ? ELSE received_at END,
        paid_at = COALESCE(paid_at, ?), ordered_at = COALESCE(ordered_at, ?), updated_at = ? WHERE id = ?`,
      [open === 0 ? 'received' : 'partially_received', open, at, po.paid_at ?? po.ordered_at ?? at, at, nowIso(), po.id]);
    return lotId;
  });
}

export function listPurchases(db: Db, opts: { status?: string; open?: boolean; limit?: number } = {}) {
  const where: string[] = [];
  const p: (string | number)[] = [];
  if (opts.status) { where.push('po.status = ?'); p.push(opts.status); }
  if (opts.open) where.push("po.status IN ('planned','ordered','paid','partially_received','problem')");
  const rows = db.all<Record<string, unknown>>(`
    SELECT po.*, COUNT(l.id) AS line_count, COALESCE(SUM(l.qty), 0) AS units, COALESCE(SUM(l.received_qty), 0) AS received_units,
      COALESCE(SUM(l.qty * l.unit_price), 0) AS goods_value
    FROM purchase_orders po LEFT JOIN purchase_lines l ON l.po_id = po.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY po.id ORDER BY po.id DESC LIMIT ?`, [...p, opts.limit ?? 300]);
  return rows.map(r => ({
    id: r.id, supplier: r.supplier, platform: r.platform, externalRef: r.external_ref, status: r.status, vatTreatment: r.vat_treatment,
    shippingCost: r.shipping_cost, otherCosts: r.other_costs, refundAmount: r.refund_amount, orderedAt: r.ordered_at, paidAt: r.paid_at,
    receivedAt: r.received_at, problemNote: r.problem_note, notes: r.notes, createdAt: r.created_at, lineCount: r.line_count, units: r.units,
    receivedUnits: r.received_units, goodsValue: r.goods_value,
    total: Math.round(((r.goods_value as number) + (r.shipping_cost as number) + (r.other_costs as number)) * 100) / 100,
  }));
}

export function getPurchase(db: Db, id: number) {
  const po = listPurchases(db, { limit: 100000 }).find(x => x.id === id);
  if (!po) throw new ApiError(404, `Einkauf #${id} nicht gefunden`);
  const alloc = lineAllocations(db, id);
  const lines = db.all<LineRow>('SELECT * FROM purchase_lines WHERE po_id = ? ORDER BY id', [id]).map(l => ({
    id: l.id, productId: l.product_id, name: l.name, setName: l.set_name, finish: l.finish, condition: l.condition, language: l.language,
    qty: l.qty, unitPrice: l.unit_price, receivedQty: l.received_qty, decisionId: l.decision_id,
    allocatedCosts: alloc.get(l.id) ?? 0, unitLandedCost: Math.round((l.unit_price + (alloc.get(l.id) ?? 0) / l.qty) * 100) / 100,
    lots: db.all<{ id: number; qty_received: number }>('SELECT id, qty_received FROM stock_lots WHERE purchase_line_id = ?', [l.id]).map(x => ({ id: x.id, code: lotCode(x.id), qty: x.qty_received })),
  }));
  return { ...po, lines };
}

export function deletePurchase(db: Db, id: number): void {
  const po = getPo(db, id);
  if (po.status !== 'planned') throw new ApiError(409, 'Nur geplante (noch nicht bestellte) Einkäufe können gelöscht werden – sonst stornieren');
  db.run('DELETE FROM purchase_orders WHERE id = ?', [id]);
}
