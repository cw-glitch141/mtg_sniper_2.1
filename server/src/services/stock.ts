/**
 * Lagerverwaltung: Chargen (stock_lots), Lagerplätze, Bewegungsprotokoll, Reservierungen.
 *
 * Mengenlogik je Charge:  verfügbar = qty_on_hand − qty_reserved
 *   reserve:  qty_reserved += n                 (Auftrag angelegt)
 *   release:  qty_reserved −= n                 (Storno / fehlende Karte)
 *   ship:     qty_on_hand −= n, qty_reserved −= n, qty_sold += n
 *   return:   qty_on_hand += n, qty_sold −= n   (Wiedereinlagerung)
 * Datenbank-Constraints (qty_reserved ≤ qty_on_hand, alle ≥ 0) verhindern Doppelverkäufe auch bei Fehlern.
 * Privatbestand (ownership = 'private') wird nie reserviert, verkauft oder in Geschäftszahlen gezählt.
 */
import { nowIso, type Db } from '../db/database.ts';
import type { AppSettings } from '../domain/settings.ts';
import { CONDITIONS } from '../domain/types.ts';
import { ApiError } from '../api/http.ts';

export const lotCode = (id: number) => 'L' + String(id).padStart(6, '0');
export function parseLotCode(code: string): number | null {
  const m = /^L?0*(\d+)$/i.exec(code.trim());
  return m ? Number(m[1]) : null;
}

export function movement(db: Db, lotId: number, type: string, qty: number, ref?: { type: string; id: number } | null, note?: string | null): void {
  db.run('INSERT INTO stock_movements (lot_id, type, qty, ref_type, ref_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [lotId, type, qty, ref?.type ?? null, ref?.id ?? null, note ?? null, nowIso()]);
}

// ---------------------------------------------------------------------------- Lagerplätze

export function ensureLocation(db: Db, s: AppSettings, code: string | null | undefined, warehouse?: string | null): number | null {
  if (code == null || code.trim() === '') return null;
  const c = code.trim().toUpperCase();
  if (!new RegExp(s.business.locationPattern).test(c)) throw new ApiError(400, `Lagerplatz "${c}" passt nicht zum Schema ${s.business.locationPattern} (z. B. A01)`);
  const wh = (warehouse ?? s.business.defaultWarehouse).trim().toUpperCase() || 'HAUPT';
  const ex = db.get<{ id: number }>('SELECT id FROM locations WHERE warehouse = ? AND code = ?', [wh, c]);
  if (ex) return ex.id;
  return db.run('INSERT INTO locations (warehouse, code, created_at) VALUES (?, ?, ?)', [wh, c, nowIso()]).lastInsertRowid;
}

export function listLocations(db: Db) {
  return db.all(`SELECT l.id, l.warehouse, l.code, l.description, l.active,
      COUNT(s.id) AS lots, COALESCE(SUM(s.qty_on_hand), 0) AS units
    FROM locations l LEFT JOIN stock_lots s ON s.location_id = l.id AND s.qty_on_hand > 0
    GROUP BY l.id ORDER BY l.warehouse, l.code`);
}

// ---------------------------------------------------------------------------- Chargen

export interface LotRow {
  id: number; game_id: string; product_id: number | null; name: string; set_name: string | null; set_code: string | null; collector_number: string | null;
  finish: string; condition: string | null; language: string | null; ownership: 'business' | 'private'; private_deck: string | null;
  qty_received: number; qty_on_hand: number; qty_reserved: number; qty_sold: number; unit_cost: number; allocated_cost_total: number;
  vat_treatment: string; vat_rate_pct: number; purchase_line_id: number | null; acquired_at: string; received_at: string; location_id: number | null;
  list_price: number | null; list_platform: string | null; listed_at: string | null; min_price_override: number | null; notes: string | null;
  created_at: string; updated_at: string;
}

export const unitAlloc = (l: Pick<LotRow, 'allocated_cost_total' | 'qty_received'>) => (l.qty_received > 0 ? l.allocated_cost_total / l.qty_received : 0);
export const unitFullCost = (l: Pick<LotRow, 'unit_cost' | 'allocated_cost_total' | 'qty_received'>) => l.unit_cost + unitAlloc(l);

export function getLot(db: Db, id: number): LotRow {
  const r = db.get<LotRow>('SELECT * FROM stock_lots WHERE id = ?', [id]);
  if (!r) throw new ApiError(404, `Charge ${lotCode(id)} nicht gefunden`);
  return r;
}

export interface ManualLotInput {
  productId?: number | null; name?: string; setName?: string | null; finish?: string; condition?: string | null; language?: string | null;
  qty: number; unitCost: number; allocatedCostTotal?: number; acquiredAt?: string; locationCode?: string | null;
  ownership?: 'business' | 'private'; privateDeck?: string | null; vatTreatment?: string; notes?: string | null;
}

function validateVariant(i: { condition?: string | null; finish?: string; language?: string | null }) {
  if (i.condition && !(CONDITIONS as string[]).includes(i.condition)) throw new ApiError(400, `Zustand "${i.condition}" ungültig`);
  if (i.finish && !['foil', 'nonfoil'].includes(i.finish)) throw new ApiError(400, 'finish muss foil oder nonfoil sein');
  if (i.language && !/^[a-z]{2,3}$/.test(i.language)) throw new ApiError(400, `Sprache "${i.language}" ungültig (z. B. en, de)`);
}

/** Charge anlegen (Wareneingang aus Einkauf, Anfangsbestand oder Privatbestand). */
export function createLot(db: Db, s: AppSettings, i: ManualLotInput, purchaseLineId: number | null = null): number {
  if (!Number.isInteger(i.qty) || i.qty < 1) throw new ApiError(400, 'Menge muss eine ganze Zahl ≥ 1 sein');
  if (!(i.unitCost >= 0)) throw new ApiError(400, 'Einstandspreis muss ≥ 0 sein');
  validateVariant(i);
  let name = i.name ?? '', setName = i.setName ?? null, setCode: string | null = null, cn: string | null = null;
  if (i.productId != null) {
    const p = db.get<{ name: string; set_name: string | null; set_code: string | null; collector_number: string | null }>(
      'SELECT name, set_name, set_code, collector_number FROM products WHERE id = ?', [i.productId]);
    if (!p) throw new ApiError(404, 'Produkt nicht gefunden');
    name ||= p.name; setName ??= p.set_name; setCode = p.set_code; cn = p.collector_number;
  }
  if (!name.trim()) throw new ApiError(400, 'Kartenname oder Produkt erforderlich');
  const loc = ensureLocation(db, s, i.locationCode);
  const now = nowIso();
  const id = db.run(`INSERT INTO stock_lots (product_id, name, set_name, set_code, collector_number, finish, condition, language, ownership, private_deck,
      qty_received, qty_on_hand, unit_cost, allocated_cost_total, vat_treatment, purchase_line_id, acquired_at, received_at, location_id, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [i.productId ?? null, name.trim(), setName, setCode, cn, i.finish ?? 'nonfoil', i.condition || null, i.language || null, i.ownership ?? 'business',
      i.privateDeck ?? null, i.qty, i.qty, i.unitCost, i.allocatedCostTotal ?? 0, i.vatTreatment ?? 'none', purchaseLineId,
      i.acquiredAt ?? now.slice(0, 10), now, loc, i.notes ?? null, now, now]).lastInsertRowid;
  movement(db, id, 'receive', i.qty, purchaseLineId ? { type: 'purchase_line', id: purchaseLineId } : null, purchaseLineId ? null : 'manuell erfasst');
  return id;
}

export interface LotQuery {
  q?: string; ownership?: string; status?: string; locationId?: number; productId?: number; slowOnly?: boolean; limit?: number; offset?: number;
}

export function queryLots(db: Db, s: AppSettings, q: LotQuery) {
  const where: string[] = [];
  const p: (string | number)[] = [];
  where.push('s.ownership = ?'); p.push(q.ownership === 'private' ? 'private' : 'business');
  if (q.q) {
    const id = parseLotCode(q.q);
    where.push('(s.name LIKE ? OR s.set_name LIKE ? OR s.id = ? OR CAST(p.external_id AS TEXT) = ? OR loc.code = ?)');
    p.push(`%${q.q}%`, `%${q.q}%`, id ?? -1, q.q.trim(), q.q.trim().toUpperCase());
  }
  if (q.locationId != null) { where.push('s.location_id = ?'); p.push(q.locationId); }
  if (q.productId != null) { where.push('s.product_id = ?'); p.push(q.productId); }
  switch (q.status) {
    case 'available': where.push('s.qty_on_hand - s.qty_reserved > 0'); break;
    case 'reserved': where.push('s.qty_reserved > 0'); break;
    case 'soldout': where.push('s.qty_on_hand = 0'); break;
    case 'listed': where.push('s.qty_on_hand - s.qty_reserved > 0 AND s.list_price IS NOT NULL'); break;
    case 'unlisted': where.push('s.qty_on_hand - s.qty_reserved > 0 AND s.list_price IS NULL'); break;
    case 'onhand': default: if (q.status !== 'all') where.push('s.qty_on_hand > 0');
  }
  if (q.slowOnly) { where.push("s.qty_on_hand - s.qty_reserved > 0 AND s.received_at <= ?"); p.push(new Date(Date.now() - s.limits.slowMoverDays * 864e5).toISOString()); }
  const w = where.join(' AND ');
  const from = `FROM stock_lots s LEFT JOIN products p ON p.id = s.product_id LEFT JOIN locations loc ON loc.id = s.location_id
    LEFT JOIN price_latest pl ON pl.product_id = s.product_id AND pl.finish = s.finish AND pl.source = 'cardmarket_price_guide'
    LEFT JOIN purchase_lines li ON li.id = s.purchase_line_id LEFT JOIN purchase_orders po ON po.id = li.po_id`;
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n ${from} WHERE ${w}`, p)?.n ?? 0;
  const rows = db.all<LotRow & { external_id: number | null; location_code: string | null; warehouse: string | null; market_trend: number | null; po_id: number | null; po_status: string | null; supplier: string | null; revenue: number | null }>(`
    SELECT s.*, p.external_id, loc.code AS location_code, loc.warehouse, pl.trend AS market_trend, po.id AS po_id, po.status AS po_status, po.supplier,
      (SELECT SUM((a.qty - a.returned_qty) * ol.unit_price) FROM sales_allocations a JOIN sales_order_lines ol ON ol.id = a.line_id
        WHERE a.lot_id = s.id AND a.status IN ('shipped','returned')) AS revenue
    ${from} WHERE ${w} ORDER BY loc.warehouse IS NULL, loc.warehouse, loc.code, s.name COLLATE NOCASE, s.id
    LIMIT ? OFFSET ?`, [...p, Math.min(q.limit ?? 200, 2000), q.offset ?? 0]);
  return { total, items: rows.map(r => toLotView(r, s)) };
}

export function toLotView(r: LotRow & { external_id?: number | null; location_code?: string | null; warehouse?: string | null; market_trend?: number | null; po_id?: number | null; po_status?: string | null; supplier?: string | null; revenue?: number | null }, s: AppSettings) {
  const available = r.qty_on_hand - r.qty_reserved;
  const ageDays = Math.floor((Date.now() - Date.parse(r.received_at)) / 864e5);
  return {
    id: r.id, code: lotCode(r.id), productId: r.product_id, externalId: r.external_id ?? null, name: r.name, setName: r.set_name, setCode: r.set_code,
    collectorNumber: r.collector_number, finish: r.finish, condition: r.condition, language: r.language, ownership: r.ownership, privateDeck: r.private_deck,
    qtyReceived: r.qty_received, qtyOnHand: r.qty_on_hand, qtyReserved: r.qty_reserved, qtySold: r.qty_sold, qtyAvailable: available,
    unitCost: r.unit_cost, unitAlloc: Math.round(unitAlloc(r) * 100) / 100, unitFullCost: Math.round(unitFullCost(r) * 100) / 100,
    vatTreatment: r.vat_treatment, acquiredAt: r.acquired_at, receivedAt: r.received_at, ageDays,
    slow: available > 0 && ageDays >= s.limits.slowMoverDays,
    locationId: r.location_id, location: r.location_code ? `${r.location_code}` : null, warehouse: r.warehouse ?? null,
    listPrice: r.list_price, listPlatform: r.list_platform, listedAt: r.listed_at, minPriceOverride: r.min_price_override,
    salesStatus: r.qty_on_hand === 0 ? (r.qty_sold > 0 ? 'verkauft' : 'ausgebucht') : available === 0 ? 'reserviert' : r.list_price != null ? 'angeboten' : 'nicht angeboten',
    deliveryStatus: r.po_status ?? (r.purchase_line_id ? null : 'manuell'), purchaseOrderId: r.po_id ?? null, supplier: r.supplier ?? null,
    marketTrend: r.market_trend ?? null, realizedRevenue: r.revenue ?? 0, notes: r.notes,
  };
}

// ---------------------------------------------------------------------------- Änderungen an Chargen

export interface LotPatch { locationCode?: string | null; listPrice?: number | null; listPlatform?: string | null; minPriceOverride?: number | null; notes?: string | null; condition?: string | null; language?: string | null }

export function patchLot(db: Db, s: AppSettings, id: number, i: LotPatch): void {
  const lot = getLot(db, id);
  validateVariant({ condition: i.condition, language: i.language });
  const sets: string[] = [];
  const p: (string | number | null)[] = [];
  if (i.locationCode !== undefined) {
    const loc = ensureLocation(db, s, i.locationCode);
    sets.push('location_id = ?'); p.push(loc);
    movement(db, id, 'move', 0, null, `Lagerplatz → ${i.locationCode || 'ohne'}`);
  }
  if (i.listPrice !== undefined) {
    if (i.listPrice != null && !(i.listPrice > 0)) throw new ApiError(400, 'Angebotspreis muss positiv sein');
    if (lot.ownership === 'private' && i.listPrice != null) throw new ApiError(400, 'Privatbestand kann nicht angeboten werden');
    // Preisänderung startet die Angebotsdauer neu (sonst würde "lange unverkauft" sofort wieder anschlagen).
    sets.push('list_price = ?', 'listed_at = ?');
    p.push(i.listPrice, i.listPrice == null ? null : (i.listPrice !== lot.list_price || !lot.listed_at ? nowIso() : lot.listed_at));
  }
  if (i.listPlatform !== undefined) { sets.push('list_platform = ?'); p.push(i.listPlatform); }
  if (i.minPriceOverride !== undefined) { sets.push('min_price_override = ?'); p.push(i.minPriceOverride); }
  if (i.notes !== undefined) { sets.push('notes = ?'); p.push(i.notes); }
  if (i.condition !== undefined) { sets.push('condition = ?'); p.push(i.condition); }
  if (i.language !== undefined) { sets.push('language = ?'); p.push(i.language); }
  if (!sets.length) return;
  sets.push('updated_at = ?'); p.push(nowIso());
  db.run(`UPDATE stock_lots SET ${sets.join(', ')} WHERE id = ?`, [...p, id]);
}

/** Bestandskorrektur (Inventur). Nie unter die reservierte Menge. */
export function adjustLot(db: Db, id: number, delta: number, reason: string): void {
  if (!Number.isInteger(delta) || delta === 0) throw new ApiError(400, 'Korrektur muss eine ganze Zahl ≠ 0 sein');
  if (!reason?.trim()) throw new ApiError(400, 'Bitte einen Grund angeben');
  const lot = getLot(db, id);
  if (lot.qty_on_hand + delta < lot.qty_reserved) throw new ApiError(409, `Nicht möglich: ${lot.qty_reserved} Exemplar(e) sind für Aufträge reserviert`);
  db.run('UPDATE stock_lots SET qty_on_hand = qty_on_hand + ?, updated_at = ? WHERE id = ?', [delta, nowIso(), id]);
  movement(db, id, delta < 0 ? 'writeoff' : 'adjust', delta, null, reason.trim());
}

/**
 * Teilmenge einer Charge abspalten (anderer Lagerplatz oder Wechsel Geschäft ↔ Privat).
 * Einstand und Nebenkosten werden anteilig mitgenommen. Reservierte Exemplare bleiben in der alten Charge.
 */
export function splitLot(db: Db, s: AppSettings, id: number, qty: number, target: { locationCode?: string | null; ownership?: 'business' | 'private'; privateDeck?: string | null }): number {
  const lot = getLot(db, id);
  if (!Number.isInteger(qty) || qty < 1) throw new ApiError(400, 'Menge muss ≥ 1 sein');
  if (qty > lot.qty_on_hand - lot.qty_reserved) throw new ApiError(409, `Nur ${lot.qty_on_hand - lot.qty_reserved} Exemplar(e) frei verfügbar`);
  const ownership = target.ownership ?? lot.ownership;
  const allocMove = Math.round(unitAlloc(lot) * qty * 100) / 100;
  const now = nowIso();
  const loc = target.locationCode !== undefined ? ensureLocation(db, s, target.locationCode) : lot.location_id;
  db.run(`UPDATE stock_lots SET qty_received = qty_received - ?, qty_on_hand = qty_on_hand - ?, allocated_cost_total = MAX(0, allocated_cost_total - ?), updated_at = ? WHERE id = ?`,
    [qty, qty, allocMove, now, id]);
  const newId = db.run(`INSERT INTO stock_lots (game_id, product_id, name, set_name, set_code, collector_number, finish, condition, language, ownership, private_deck,
      qty_received, qty_on_hand, unit_cost, allocated_cost_total, vat_treatment, vat_rate_pct, purchase_line_id, acquired_at, received_at, location_id,
      list_price, list_platform, listed_at, notes, created_at, updated_at)
    SELECT game_id, product_id, name, set_name, set_code, collector_number, finish, condition, language, ?, ?, ?, ?, unit_cost, ?, vat_treatment, vat_rate_pct,
      purchase_line_id, acquired_at, received_at, ?, CASE WHEN ? = 'private' THEN NULL ELSE list_price END, list_platform,
      CASE WHEN ? = 'private' THEN NULL ELSE listed_at END, notes, ?, ? FROM stock_lots WHERE id = ?`,
    [ownership, ownership === 'private' ? (target.privateDeck ?? null) : null, qty, qty, allocMove, loc, ownership, ownership, now, now, id]).lastInsertRowid;
  const note = ownership !== lot.ownership ? `${lot.ownership === 'business' ? 'Geschäft → Privat' : 'Privat → Geschäft'}` : 'Umlagerung';
  movement(db, id, 'transfer', -qty, { type: 'lot', id: newId }, note);
  movement(db, newId, 'transfer', qty, { type: 'lot', id }, note);
  return newId;
}

export function lotMovements(db: Db, id: number) {
  return db.all('SELECT id, type, qty, ref_type AS refType, ref_id AS refId, note, actor, created_at AS createdAt FROM stock_movements WHERE lot_id = ? ORDER BY id', [id]);
}

// ---------------------------------------------------------------------------- Reservierung (FIFO)

export interface VariantRequest { productId: number | null; name: string; setName?: string | null; finish: string; condition?: string | null; language?: string | null }

/** Freie Geschäftsbestände einer Variante, älteste zuerst (FIFO). */
export function availableLots(db: Db, v: VariantRequest): LotRow[] {
  const where = ["ownership = 'business'", 'qty_on_hand - qty_reserved > 0', 'finish = ?'];
  const p: (string | number)[] = [v.finish];
  if (v.productId != null) { where.push('product_id = ?'); p.push(v.productId); }
  else { where.push('product_id IS NULL AND name = ? COLLATE NOCASE'); p.push(v.name); if (v.setName) { where.push('set_name = ? COLLATE NOCASE'); p.push(v.setName); } }
  if (v.condition) { where.push('condition = ?'); p.push(v.condition); }
  if (v.language) { where.push('language = ?'); p.push(v.language); }
  return db.all<LotRow>(`SELECT * FROM stock_lots WHERE ${where.join(' AND ')} ORDER BY received_at, id`, p);
}

/**
 * Reserviert `qty` Exemplare für eine Auftragsposition. Wirft 409 mit Fehlmenge, wenn nicht genug frei ist.
 * preferLotId: bestimmte Charge zuerst (z. B. beim Scannen).
 */
export function reserveForLine(db: Db, lineId: number, v: VariantRequest, qty: number, preferLotId?: number | null): number {
  let lots = availableLots(db, v);
  if (preferLotId != null) lots = [...lots.filter(l => l.id === preferLotId), ...lots.filter(l => l.id !== preferLotId)];
  const free = lots.reduce((a, l) => a + l.qty_on_hand - l.qty_reserved, 0);
  if (free < qty) {
    throw new ApiError(409, `Nicht genug Bestand für ${v.name} (${[v.finish, v.condition, v.language].filter(Boolean).join('/')}): benötigt ${qty}, frei ${free}`, { missing: qty - free });
  }
  let need = qty;
  const now = nowIso();
  for (const l of lots) {
    if (need <= 0) break;
    const take = Math.min(need, l.qty_on_hand - l.qty_reserved);
    db.run('UPDATE stock_lots SET qty_reserved = qty_reserved + ?, updated_at = ? WHERE id = ?', [take, now, l.id]);
    db.run("INSERT INTO sales_allocations (line_id, lot_id, qty, status, unit_cost, unit_alloc, created_at) VALUES (?, ?, ?, 'reserved', ?, ?, ?)",
      [lineId, l.id, take, l.unit_cost, unitAlloc(l), now]);
    movement(db, l.id, 'reserve', 0, { type: 'sales_line', id: lineId }, `${take} reserviert`);
    need -= take;
  }
  return qty;
}

interface AllocRow { id: number; line_id: number; lot_id: number; qty: number; status: string; returned_qty: number }

export function releaseAllocation(db: Db, a: AllocRow, qty = a.qty, note = 'Reservierung aufgehoben'): void {
  if (a.status !== 'reserved') throw new ApiError(409, 'Nur reservierte Zuordnungen können freigegeben werden');
  if (qty < 1 || qty > a.qty) throw new ApiError(400, 'Ungültige Menge');
  db.run('UPDATE stock_lots SET qty_reserved = qty_reserved - ?, updated_at = ? WHERE id = ?', [qty, nowIso(), a.lot_id]);
  if (qty === a.qty) db.run("UPDATE sales_allocations SET status = 'released' WHERE id = ?", [a.id]);
  else db.run('UPDATE sales_allocations SET qty = qty - ? WHERE id = ?', [qty, a.id]);
  movement(db, a.lot_id, 'release', 0, { type: 'sales_line', id: a.line_id }, `${qty} ${note}`);
}

export function shipAllocation(db: Db, a: AllocRow, orderId: number): void {
  if (a.status !== 'reserved') return;
  const lot = getLot(db, a.lot_id);
  db.run('UPDATE stock_lots SET qty_on_hand = qty_on_hand - ?, qty_reserved = qty_reserved - ?, qty_sold = qty_sold + ?, updated_at = ? WHERE id = ?',
    [a.qty, a.qty, a.qty, nowIso(), a.lot_id]);
  // Einstand zum Versandzeitpunkt festschreiben (berücksichtigt nachträglich geänderte Einkaufsnebenkosten)
  db.run("UPDATE sales_allocations SET status = 'shipped', unit_cost = ?, unit_alloc = ? WHERE id = ?", [lot.unit_cost, unitAlloc(lot), a.id]);
  movement(db, a.lot_id, 'ship', -a.qty, { type: 'sales_order', id: orderId });
}

export function returnAllocation(db: Db, a: AllocRow, qty: number, restock: boolean, orderId: number): void {
  if (a.status !== 'shipped' && a.status !== 'returned') throw new ApiError(409, 'Nur versendete Karten können zurückkommen');
  if (qty < 1 || qty > a.qty - a.returned_qty) throw new ApiError(400, `Höchstens ${a.qty - a.returned_qty} Exemplar(e) rückgabefähig`);
  db.run(`UPDATE sales_allocations SET returned_qty = returned_qty + ?, restocked_qty = restocked_qty + ?,
      status = CASE WHEN returned_qty + ? >= qty THEN 'returned' ELSE status END WHERE id = ?`, [qty, restock ? qty : 0, qty, a.id]);
  db.run('UPDATE stock_lots SET qty_on_hand = qty_on_hand + ?, qty_sold = qty_sold - ?, updated_at = ? WHERE id = ?', [qty, qty, nowIso(), a.lot_id]);
  movement(db, a.lot_id, 'return', qty, { type: 'sales_order', id: orderId }, restock ? 'Rücksendung eingelagert' : 'Rücksendung');
  if (!restock) {
    db.run('UPDATE stock_lots SET qty_on_hand = qty_on_hand - ?, updated_at = ? WHERE id = ?', [qty, nowIso(), a.lot_id]);
    movement(db, a.lot_id, 'writeoff', -qty, { type: 'sales_order', id: orderId }, 'Rücksendung beschädigt/verloren');
  }
}
