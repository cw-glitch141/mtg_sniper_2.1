/**
 * Datenmigration 2.0 → 2.1: Die einfache Tabelle "inventory" (ein Posten = Kauf + ggf. Verkauf)
 * wird in Einkaufsauftrag + Position + Bestandscharge (+ Verkaufsauftrag) überführt.
 * Die alte Tabelle bleibt unverändert als "inventory_v20_legacy" erhalten (kein Datenverlust).
 */
import type { Db } from './database.ts';

interface Legacy {
  id: number; product_id: number | null; name: string; set_name: string | null; condition: string | null; language: string | null; finish: string;
  qty: number; buy_price: number; buy_shipping: number; buy_other_costs: number; buy_date: string; seller: string | null; buy_source: string | null;
  status: string; list_price: number | null; listed_at: string | null; sell_price: number | null; sell_date: string | null;
  platform_fees: number | null; sell_shipping_cost: number | null; sell_other_costs: number | null; decision_id: number | null; notes: string | null;
  created_at: string;
}

export function migrateLegacyInventory(db: Db): void {
  const now = new Date().toISOString();
  const rows = db.all<Legacy>('SELECT * FROM inventory ORDER BY id');
  for (const r of rows) {
    const received = r.status !== 'ordered';
    const poStatus = r.status === 'returned' ? 'returned' : received ? 'received' : 'paid';
    const po = db.run(`INSERT INTO purchase_orders (supplier, platform, status, shipping_cost, other_costs, refund_amount, ordered_at, paid_at, received_at, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.seller, r.buy_source ?? 'cardmarket', poStatus, r.buy_shipping, r.buy_other_costs, r.status === 'returned' ? r.buy_price * r.qty : 0,
        r.buy_date, r.buy_date, received ? r.buy_date : null, `Aus Journal 2.0 übernommen (Posten #${r.id})` + (r.notes ? ` – ${r.notes}` : ''), now, now]).lastInsertRowid;
    const line = db.run(`INSERT INTO purchase_lines (po_id, product_id, name, set_name, finish, condition, language, qty, unit_price, received_qty, decision_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [po, r.product_id, r.name, r.set_name, r.finish, r.condition, r.language, r.qty, r.buy_price, received ? r.qty : 0, r.decision_id]).lastInsertRowid;
    if (r.decision_id) db.run('UPDATE decisions SET purchase_line_id = ? WHERE id = ?', [line, r.decision_id]);
    if (!received || r.status === 'returned') continue;

    const sold = r.status === 'sold';
    const lot = db.run(`INSERT INTO stock_lots (product_id, name, set_name, finish, condition, language, qty_received, qty_on_hand, qty_reserved, qty_sold,
        unit_cost, allocated_cost_total, purchase_line_id, acquired_at, received_at, list_price, list_platform, listed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.product_id, r.name, r.set_name, r.finish, r.condition, r.language, r.qty, sold ? 0 : r.qty, sold ? r.qty : 0, r.buy_price,
        r.buy_shipping + r.buy_other_costs, line, r.buy_date, r.buy_date, r.list_price, r.list_price != null ? 'cardmarket' : null, r.listed_at, now, now]).lastInsertRowid;
    db.run("INSERT INTO stock_movements (lot_id, type, qty, ref_type, ref_id, note, created_at) VALUES (?, 'receive', ?, 'purchase_line', ?, 'Migration 2.0', ?)", [lot, r.qty, line, now]);

    if (sold && r.sell_price != null) {
      const at = r.sell_date ?? r.buy_date;
      const so = db.run(`INSERT INTO sales_orders (platform, status, payment_status, shipping_cost, platform_fee, other_costs, ordered_at, paid_at, shipped_at, completed_at, notes, created_at, updated_at)
        VALUES ('cardmarket', 'completed', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.sell_shipping_cost, r.platform_fees, r.sell_other_costs, at, at, at, at, `Aus Journal 2.0 übernommen (Posten #${r.id})`, now, now]).lastInsertRowid;
      const sl = db.run('INSERT INTO sales_order_lines (order_id, product_id, name, set_name, finish, condition, language, qty, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [so, r.product_id, r.name, r.set_name, r.finish, r.condition, r.language, r.qty, r.sell_price]).lastInsertRowid;
      db.run("INSERT INTO sales_allocations (line_id, lot_id, qty, status, unit_cost, unit_alloc, created_at) VALUES (?, ?, ?, 'shipped', ?, ?, ?)",
        [sl, lot, r.qty, r.buy_price, (r.buy_shipping + r.buy_other_costs) / r.qty, now]);
      db.run("INSERT INTO stock_movements (lot_id, type, qty, ref_type, ref_id, note, created_at) VALUES (?, 'ship', ?, 'sales_order', ?, 'Migration 2.0', ?)", [lot, -r.qty, so, now]);
    }
  }
  db.exec('ALTER TABLE inventory RENAME TO inventory_v20_legacy');
}
