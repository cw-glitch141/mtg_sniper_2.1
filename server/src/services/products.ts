import type { Db } from '../db/database.ts';
import type { Finish, GuidePrices, ProductInfo, SnapshotPoint } from '../domain/types.ts';

export interface ProductRow {
  id: number; external_id: number; name: string; set_name: string | null; set_code: string | null;
  collector_number: string | null; rarity: string | null; image_url: string | null; mapping_status: string;
  expansion_external_id: number | null; finishes: string | null;
}

export function toProduct(r: ProductRow): ProductInfo {
  return {
    id: r.id, externalId: r.external_id, name: r.name, setName: r.set_name, setCode: r.set_code,
    collectorNumber: r.collector_number, rarity: r.rarity, imageUrl: r.image_url, mappingStatus: r.mapping_status,
  };
}

const PRODUCT_COLS = 'id, external_id, name, set_name, set_code, collector_number, rarity, image_url, mapping_status, expansion_external_id, finishes';

export function getProduct(db: Db, id: number): ProductInfo | null {
  const r = db.get<ProductRow>(`SELECT ${PRODUCT_COLS} FROM products WHERE id = ?`, [id]);
  return r ? toProduct(r) : null;
}

export function getProductByExternal(db: Db, externalId: number, gameId = 'mtg'): ProductInfo | null {
  const r = db.get<ProductRow>(`SELECT ${PRODUCT_COLS} FROM products WHERE game_id = ? AND source = 'cardmarket' AND external_id = ?`, [gameId, externalId]);
  return r ? toProduct(r) : null;
}

interface PriceRowDb { avg: number | null; low: number | null; trend: number | null; avg1: number | null; avg7: number | null; avg30: number | null; source_created_at: string }

export function toGuide(r: PriceRowDb): GuidePrices {
  return { avg: r.avg, low: r.low, trend: r.trend, avg1: r.avg1, avg7: r.avg7, avg30: r.avg30, sourceCreatedAt: r.source_created_at };
}

export function getGuide(db: Db, productId: number, finish: Finish): GuidePrices | null {
  const r = db.get<PriceRowDb>("SELECT avg, low, trend, avg1, avg7, avg30, source_created_at FROM price_latest WHERE product_id = ? AND finish = ? AND source = 'cardmarket_price_guide'", [productId, finish]);
  return r ? toGuide(r) : null;
}

export function getHistory(db: Db, productId: number, finish: Finish, days = 120): SnapshotPoint[] {
  return db.all<SnapshotPoint>(`
    SELECT snapshot_date AS date, trend, avg1, avg7, avg30, low FROM price_snapshots
    WHERE product_id = ? AND finish = ? AND source = 'cardmarket_price_guide' AND snapshot_date >= date('now', ?)
    ORDER BY snapshot_date`, [productId, finish, `-${days} days`]);
}

/** Historie mehrerer Varianten auf einmal (für den Scanner). Schlüssel: "<productId>:<finish>". */
export function getHistoryBulk(db: Db, keys: { productId: number; finish: Finish }[], days = 45): Map<string, SnapshotPoint[]> {
  const out = new Map<string, SnapshotPoint[]>();
  if (!keys.length) return out;
  db.exec('CREATE TEMP TABLE IF NOT EXISTS tmp_keys (product_id INTEGER, finish TEXT, PRIMARY KEY (product_id, finish))');
  db.exec('DELETE FROM tmp_keys');
  db.tx(() => {
    const st = db.raw.prepare('INSERT OR IGNORE INTO tmp_keys VALUES (?, ?)');
    for (const k of keys) st.run(k.productId, k.finish);
  });
  const rows = db.all<SnapshotPoint & { product_id: number; finish: string }>(`
    SELECT s.product_id, s.finish, s.snapshot_date AS date, s.trend, s.avg1, s.avg7, s.avg30, s.low
    FROM price_snapshots s JOIN tmp_keys k ON k.product_id = s.product_id AND k.finish = s.finish
    WHERE s.source = 'cardmarket_price_guide' AND s.snapshot_date >= date('now', ?)
    ORDER BY s.product_id, s.finish, s.snapshot_date`, [`-${days} days`]);
  for (const r of rows) {
    const key = `${r.product_id}:${r.finish}`;
    let list = out.get(key);
    if (!list) { list = []; out.set(key, list); }
    list.push({ date: r.date, trend: r.trend, avg1: r.avg1, avg7: r.avg7, avg30: r.avg30, low: r.low });
  }
  return out;
}

export function searchProducts(db: Db, q: string, limit = 30) {
  const term = q.trim();
  if (!term) return [];
  const byId = /^\d+$/.test(term) ? Number(term) : -1;
  return db.all(`
    SELECT p.id, p.external_id AS externalId, p.name, p.set_name AS setName, p.set_code AS setCode,
           p.collector_number AS collectorNumber, p.rarity, p.image_url AS imageUrl,
           n.trend AS trend, n.avg30 AS avg30, f.trend AS trendFoil
    FROM products p
    LEFT JOIN price_latest n ON n.product_id = p.id AND n.finish = 'nonfoil'
    LEFT JOIN price_latest f ON f.product_id = p.id AND f.finish = 'foil'
    WHERE p.name LIKE ? OR p.external_id = ? OR (p.set_code = ? COLLATE NOCASE)
    ORDER BY (p.name = ? COLLATE NOCASE) DESC, COALESCE(n.trend, f.trend, 0) DESC
    LIMIT ?`, [`%${term}%`, byId, term, term, limit]);
}
