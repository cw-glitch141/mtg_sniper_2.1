import { nowIso, type Db } from '../db/database.ts';
import { logger } from '../util/log.ts';
import { CONDITIONS, type Condition } from '../domain/types.ts';

const log = logger('watchlist');

/** "Sensei's Divining Top" → "senseisdiviningtop" (identisch zu v1.1.0 shared.js → nameKey). */
export function nameKey(str: string): string {
  return String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

export interface WatchEntry {
  id: number; listName: string; nameKey: string; name: string; productId: number | null; finish: string | null;
  qty: number; targetPrice: number | null; bought: boolean; url: string | null; notes: string | null; origin: string; addedAt: string;
  minCondition: string | null;   // eigener Mindestzustand je Eintrag (null = globale Einstellung)
  languages: string[] | null;    // erlaubte Sprachen je Eintrag (null = globale Einstellung)
}

interface Row { id: number; list_name: string; name_key: string; name: string; product_id: number | null; finish: string | null; qty: number; target_price: number | null; bought: number; url: string | null; notes: string | null; origin: string; added_at: string; min_condition: string | null; languages: string | null }

const toEntry = (r: Row): WatchEntry => ({
  id: r.id, listName: r.list_name, nameKey: r.name_key, name: r.name, productId: r.product_id, finish: r.finish, qty: r.qty,
  targetPrice: r.target_price, bought: !!r.bought, url: r.url, notes: r.notes, origin: r.origin, addedAt: r.added_at,
  minCondition: r.min_condition, languages: r.languages ? r.languages.split(',').filter(Boolean) : null,
});

/** Erfüllt ein Angebot die Filter des Watchlist-Eintrags? (Fallback: globale Kaufregeln) */
export function offerMatchesEntry(e: WatchEntry, offer: { condition: string | null; language: string | null }, globalWorst: string, globalLangs: string[]): boolean {
  const worst = CONDITIONS.indexOf((e.minCondition ?? globalWorst) as Condition);
  const idx = offer.condition ? CONDITIONS.indexOf(offer.condition as Condition) : -1;
  if (idx === -1 || (worst !== -1 && idx > worst)) return false;
  const langs = e.languages ?? globalLangs;
  return offer.language != null && langs.includes(offer.language);
}

export function listWatch(db: Db, listName?: string): WatchEntry[] {
  return db.all<Row>('SELECT * FROM watchlist' + (listName ? ' WHERE list_name = ?' : '') + ' ORDER BY bought, name COLLATE NOCASE', listName ? [listName] : []).map(toEntry);
}

export interface WatchInput {
  listName?: string; name?: string; productId?: number | null; finish?: string | null; qty?: number; targetPrice?: number | null; bought?: boolean;
  notes?: string | null; url?: string | null; minCondition?: string | null; languages?: string[] | null;
}

export function validateWatch(i: WatchInput, partial: boolean): string | null {
  if (!partial && (!i.name || !nameKey(i.name)) && i.productId == null) return 'Name oder Produkt erforderlich';
  if (i.minCondition != null && !(CONDITIONS as string[]).includes(i.minCondition)) return 'Mindestzustand ungültig (MT, NM, EX, GD, LP, PL, PO)';
  if (i.languages != null && (!Array.isArray(i.languages) || !i.languages.every(l => /^[a-z]{2,3}$/.test(l)))) return 'Sprachen als Liste von Kürzeln (z. B. ["en","de"])';
  if (i.qty != null && (!Number.isInteger(i.qty) || i.qty < 1 || i.qty > 999)) return 'Anzahl muss 1–999 sein';
  if (i.targetPrice != null && (typeof i.targetPrice !== 'number' || !(i.targetPrice > 0))) return 'Zielpreis muss positiv sein oder leer bleiben';
  if (i.finish != null && !['foil', 'nonfoil'].includes(i.finish)) return 'finish muss foil oder nonfoil sein';
  return null;
}

export function addWatch(db: Db, i: WatchInput, origin = 'dashboard'): WatchEntry {
  let name = i.name ?? '';
  if (!name && i.productId != null) name = db.get<{ name: string }>('SELECT name FROM products WHERE id = ?', [i.productId])?.name ?? '';
  const key = nameKey(name);
  const list = i.listName?.trim() || 'Standard';
  db.run(`INSERT INTO watchlist (list_name, name_key, name, product_id, finish, qty, target_price, bought, url, notes, origin, added_at, min_condition, languages)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO UPDATE SET qty = MAX(watchlist.qty, excluded.qty), target_price = COALESCE(excluded.target_price, watchlist.target_price),
            min_condition = COALESCE(excluded.min_condition, watchlist.min_condition), languages = COALESCE(excluded.languages, watchlist.languages)`,
    [list, key, name, i.productId ?? null, i.finish ?? null, i.qty ?? 1, i.targetPrice ?? null, i.bought ? 1 : 0, i.url ?? null, i.notes ?? null, origin, nowIso(),
      i.minCondition ?? null, i.languages?.length ? i.languages.join(',') : null]);
  return toEntry(db.get<Row>('SELECT * FROM watchlist WHERE list_name = ? AND name_key = ? AND COALESCE(product_id, 0) = ?', [list, key, i.productId ?? 0]) as Row);
}

export function updateWatch(db: Db, id: number, i: WatchInput): WatchEntry | null {
  const sets: string[] = [];
  const p: (string | number | null)[] = [];
  if (i.qty !== undefined) { sets.push('qty = ?'); p.push(i.qty); }
  if (i.targetPrice !== undefined) { sets.push('target_price = ?'); p.push(i.targetPrice); }
  if (i.bought !== undefined) { sets.push('bought = ?'); p.push(i.bought ? 1 : 0); }
  if (i.notes !== undefined) { sets.push('notes = ?'); p.push(i.notes); }
  if (i.listName !== undefined) { sets.push('list_name = ?'); p.push(i.listName || 'Standard'); }
  if (i.finish !== undefined) { sets.push('finish = ?'); p.push(i.finish); }
  if (i.minCondition !== undefined) { sets.push('min_condition = ?'); p.push(i.minCondition); }
  if (i.languages !== undefined) { sets.push('languages = ?'); p.push(i.languages?.length ? i.languages.join(',') : null); }
  if (sets.length) db.run(`UPDATE watchlist SET ${sets.join(', ')} WHERE id = ?`, [...p, id]);
  const r = db.get<Row>('SELECT * FROM watchlist WHERE id = ?', [id]);
  return r ? toEntry(r) : null;
}

export function deleteWatch(db: Db, id: number): boolean {
  return db.run('DELETE FROM watchlist WHERE id = ?', [id]).changes > 0;
}

/**
 * Sichere Übernahme der Watchlist aus der Browser-Erweiterung (v1.0/v1.1-Format).
 * Idempotent: erneutes Senden verdoppelt nichts; bestehende Dashboard-Werte werden nicht überschrieben,
 * außer Anzahl (Maximum) und fehlender Zielpreis. Die Daten in der Extension bleiben unverändert.
 */
export function importLegacyWatchlist(db: Db, entries: unknown[]): { imported: number; merged: number; skipped: number } {
  let imported = 0, merged = 0, skipped = 0;
  db.tx(() => {
    for (const raw of entries) {
      const e = raw as Record<string, unknown>;
      const name = typeof e.name === 'string' ? e.name : '';
      const key = typeof e.key === 'string' && e.key ? e.key : nameKey(name);
      if (!key || !name) { skipped++; continue; }
      const qty = Number.isInteger(e.qty) && (e.qty as number) >= 1 ? (e.qty as number) : 1;
      const target = typeof e.target === 'number' && e.target > 0 ? e.target : null;
      const exists = db.get<{ id: number }>("SELECT id FROM watchlist WHERE list_name = 'Standard' AND name_key = ? AND product_id IS NULL", [key]);
      if (exists) {
        db.run('UPDATE watchlist SET qty = MAX(qty, ?), target_price = COALESCE(target_price, ?), bought = MAX(bought, ?) WHERE id = ?',
          [qty, target, e.bought ? 1 : 0, exists.id]);
        merged++;
      } else {
        db.run(`INSERT INTO watchlist (list_name, name_key, name, qty, target_price, bought, url, origin, added_at)
                VALUES ('Standard', ?, ?, ?, ?, ?, ?, 'extension-v1', ?)`,
          [key, name, qty, target, e.bought ? 1 : 0, typeof e.url === 'string' ? e.url : null,
            typeof e.added === 'number' ? new Date(e.added).toISOString() : nowIso()]);
        imported++;
      }
    }
  });
  log.info(`Extension-Watchlist übernommen: ${imported} neu, ${merged} zusammengeführt, ${skipped} übersprungen`);
  return { imported, merged, skipped };
}
