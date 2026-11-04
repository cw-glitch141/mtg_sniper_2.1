/**
 * Import-Pipeline: Produktkatalog, Price Guide (inkl. täglicher Historisierung) und Scryfall-Zuordnung.
 * Jeder Lauf wird in import_runs protokolliert (Status, Zeilen, Datenstand, Fehlermeldung).
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { nowIso, type Db } from '../db/database.ts';
import { downloadToFile } from '../providers/http.ts';
import { readBulkFile, resolveBulkDownload, type ScryfallMapping } from '../providers/scryfall.ts';
import { logger } from '../util/log.ts';
import type { AppContext } from './context.ts';

const log = logger('import');

export type ImportSource = 'cardmarket_catalog' | 'cardmarket_price_guide' | 'scryfall';
export interface ImportResult { source: ImportSource; status: 'success' | 'skipped' | 'failed'; message: string; rows?: number; written?: number; createdAt?: string | null }

let running: Promise<unknown> | null = null;

/** Verhindert parallele Importe (ein Import zur Zeit). */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  while (running) await running.catch(() => undefined);
  const p = fn();
  running = p;
  try { return await p; } finally { if (running === p) running = null; }
}

export function isImportRunning(): boolean { return running != null; }

function startRun(db: Db, source: ImportSource): number {
  return db.run("INSERT INTO import_runs (source, started_at, status) VALUES (?, ?, 'running')", [source, nowIso()]).lastInsertRowid;
}

function finishRun(db: Db, id: number, r: Omit<ImportResult, 'source'> & { lastModified?: string | null; etag?: string | null }): void {
  db.run(`UPDATE import_runs SET finished_at = ?, status = ?, rows_total = ?, rows_written = ?, source_created_at = ?,
          http_last_modified = ?, http_etag = ?, message = ? WHERE id = ?`,
    [nowIso(), r.status, r.rows ?? null, r.written ?? null, r.createdAt ?? null, r.lastModified ?? null, r.etag ?? null, r.message, id]);
}

export function lastSuccess(db: Db, source: ImportSource): { finished_at: string; source_created_at: string | null; http_last_modified: string | null; http_etag: string | null } | undefined {
  return db.get(`SELECT finished_at, source_created_at, http_last_modified, http_etag FROM import_runs
                 WHERE source = ? AND status = 'success' ORDER BY id DESC LIMIT 1`, [source]);
}

/** Rohdatei komprimiert archivieren (Nachvollziehbarkeit), nur die letzten `keep` Dateien behalten. */
function archiveRaw(rawDir: string, source: string, createdAt: string, raw: string, keep = 14): void {
  try {
    const dir = join(rawDir, source);
    mkdirSync(dir, { recursive: true });
    const name = createdAt.replace(/[^0-9T]/g, '').slice(0, 15) + '.json.gz';
    writeFileSync(join(dir, name), gzipSync(raw));
    const files = readdirSync(dir).filter(f => f.endsWith('.json.gz')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f));
  } catch (e) {
    log.warn(`Rohdaten-Archiv für ${source} fehlgeschlagen`, e);
  }
}

/** "2026-11-04T02:47:21+0100" → "2026-11-04" (Datum in der Zeitzone der Quelle). */
export function snapshotDate(createdAt: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(createdAt);
  if (!m) throw new Error(`Ungültiger Zeitstempel im Price Guide: ${createdAt}`);
  return m[1];
}

/** ISO-Zeitstempel normalisieren ("+0100" → "+01:00"), damit Date.parse überall funktioniert. */
export function normalizeTs(ts: string): string {
  return ts.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

// ---------------------------------------------------------------------------
// Produktkatalog
// ---------------------------------------------------------------------------

export function importCatalog(ctx: AppContext, force = false): Promise<ImportResult> {
  return exclusive(async () => {
    const { db } = ctx;
    const p = ctx.providers.catalog;
    const id = startRun(db, 'cardmarket_catalog');
    try {
      const prev = force ? undefined : lastSuccess(db, 'cardmarket_catalog');
      const r = await p.fetchCatalog({ etag: prev?.http_etag, lastModified: prev?.http_last_modified });
      if (r.notModified) {
        const res = { status: 'skipped' as const, message: 'Katalog unverändert (HTTP 304)' };
        finishRun(db, id, res);
        return { source: 'cardmarket_catalog' as const, ...res };
      }
      const createdAt = normalizeTs(r.createdAt);
      const now = nowIso();
      let written = 0;
      db.tx(() => {
        const st = db.raw.prepare(`
          INSERT INTO products (game_id, source, external_id, product_type, name, expansion_external_id, metacard_id, date_added, updated_at)
          VALUES (?, 'cardmarket', ?, 'single', ?, ?, ?, ?, ?)
          ON CONFLICT (game_id, source, external_id) DO UPDATE SET
            name = excluded.name, expansion_external_id = excluded.expansion_external_id,
            metacard_id = excluded.metacard_id, date_added = excluded.date_added, updated_at = excluded.updated_at
          WHERE products.name IS NOT excluded.name OR products.expansion_external_id IS NOT excluded.expansion_external_id
             OR products.metacard_id IS NOT excluded.metacard_id`);
        for (const it of r.items) {
          written += Number(st.run(p.gameId, it.externalId, it.name, it.expansionExternalId, it.metacardId, it.dateAdded, now).changes);
        }
      });
      archiveRaw(ctx.cfg.rawDir, p.id, createdAt, r.raw, 3);
      const res = { status: 'success' as const, rows: r.items.length, written, createdAt, message: `${r.items.length} Produkte, ${written} neu/geändert`, lastModified: r.meta.lastModified, etag: r.meta.etag };
      finishRun(db, id, res);
      log.info(`Katalog: ${res.message} (Stand ${createdAt})`);
      return { source: 'cardmarket_catalog' as const, ...res };
    } catch (e) {
      const res = { status: 'failed' as const, message: (e as Error).message };
      finishRun(db, id, res);
      log.error('Katalog-Import fehlgeschlagen', e);
      return { source: 'cardmarket_catalog' as const, ...res };
    }
  });
}

// ---------------------------------------------------------------------------
// Price Guide + Historisierung
// ---------------------------------------------------------------------------

export function importPriceGuide(ctx: AppContext, force = false): Promise<ImportResult> {
  return exclusive(async () => {
    const { db } = ctx;
    const p = ctx.providers.prices;
    const id = startRun(db, 'cardmarket_price_guide');
    try {
      const prev = lastSuccess(db, 'cardmarket_price_guide');
      const r = await p.fetchPrices(force ? undefined : { etag: prev?.http_etag, lastModified: prev?.http_last_modified });
      if (r.notModified) {
        const res = { status: 'skipped' as const, message: 'Price Guide unverändert (HTTP 304)' };
        finishRun(db, id, res);
        return { source: 'cardmarket_price_guide' as const, ...res };
      }
      const createdAt = normalizeTs(r.createdAt);
      if (!force && prev?.source_created_at === createdAt) {
        const res = { status: 'skipped' as const, message: `Price Guide bereits importiert (Stand ${createdAt})`, createdAt };
        finishRun(db, id, res);
        return { source: 'cardmarket_price_guide' as const, ...res };
      }
      const day = snapshotDate(r.createdAt);
      const minHist = ctx.settings.get().analysis.historyMinPrice;
      const now = nowIso();

      const idMap = new Map<number, number>();
      for (const row of db.all<{ id: number; external_id: number }>("SELECT id, external_id FROM products WHERE game_id = ? AND source = 'cardmarket'", [p.gameId])) {
        idMap.set(row.external_id, row.id);
      }
      if (idMap.size === 0) throw new Error('Kein Produktkatalog vorhanden – zuerst den Katalog importieren.');
      // Immer historisieren: Produkte auf Watchlist, im Bestand, im Einkauf/Verkauf oder mit beobachteten Angeboten.
      const tracked = new Set(db.all<{ id: number }>(`
        SELECT product_id AS id FROM watchlist WHERE product_id IS NOT NULL
        UNION SELECT product_id FROM stock_lots WHERE product_id IS NOT NULL
        UNION SELECT product_id FROM purchase_lines WHERE product_id IS NOT NULL
        UNION SELECT product_id FROM sales_order_lines WHERE product_id IS NOT NULL
        UNION SELECT product_id FROM offers WHERE product_id IS NOT NULL`).map(x => x.id));

      let latest = 0, snaps = 0, unknown = 0, otherCategory = 0;
      db.tx(() => {
        const upLatest = db.raw.prepare(`
          INSERT INTO price_latest (product_id, finish, source, avg, low, trend, avg1, avg7, avg30, source_created_at, imported_at)
          VALUES (?, ?, 'cardmarket_price_guide', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (product_id, finish, source) DO UPDATE SET avg = excluded.avg, low = excluded.low, trend = excluded.trend,
            avg1 = excluded.avg1, avg7 = excluded.avg7, avg30 = excluded.avg30,
            source_created_at = excluded.source_created_at, imported_at = excluded.imported_at`);
        const delLatest = db.raw.prepare("DELETE FROM price_latest WHERE product_id = ? AND finish = ? AND source = 'cardmarket_price_guide'");
        const upSnap = db.raw.prepare(`
          INSERT OR REPLACE INTO price_snapshots (product_id, finish, source, snapshot_date, avg, low, trend, avg1, avg7, avg30, source_created_at)
          VALUES (?, ?, 'cardmarket_price_guide', ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const it of r.items) {
          if (it.categoryId !== 1) { otherCategory++; continue; }
          const pid = idMap.get(it.externalId);
          if (pid == null) { unknown++; continue; }
          for (const finish of ['nonfoil', 'foil'] as const) {
            const v = it[finish];
            const any = v.avg ?? v.low ?? v.trend ?? v.avg1 ?? v.avg7 ?? v.avg30;
            if (any == null) { delLatest.run(pid, finish); continue; }   // keine Werte → nichts erfinden, alten Stand entfernen
            upLatest.run(pid, finish, v.avg, v.low, v.trend, v.avg1, v.avg7, v.avg30, createdAt, now);
            latest++;
            const level = Math.max(v.trend ?? 0, v.avg30 ?? 0);
            if (level >= minHist || tracked.has(pid)) {
              upSnap.run(pid, finish, day, v.avg, v.low, v.trend, v.avg1, v.avg7, v.avg30, createdAt);
              snaps++;
            }
          }
        }
      });
      archiveRaw(ctx.cfg.rawDir, p.id, createdAt, r.raw);
      const res = {
        status: 'success' as const, rows: r.items.length, written: latest, createdAt,
        message: `${latest} Preisreihen aktualisiert, ${snaps} Snapshots für ${day}` +
          (unknown ? `, ${unknown} Produkte nicht im Katalog` : '') + (otherCategory ? `, ${otherCategory} Nicht-Singles übersprungen` : ''),
        lastModified: r.meta.lastModified, etag: r.meta.etag,
      };
      finishRun(db, id, res);
      log.info(`Price Guide: ${res.message} (Stand ${createdAt})`);
      return { source: 'cardmarket_price_guide' as const, ...res };
    } catch (e) {
      const res = { status: 'failed' as const, message: (e as Error).message };
      finishRun(db, id, res);
      log.error('Price-Guide-Import fehlgeschlagen', e);
      return { source: 'cardmarket_price_guide' as const, ...res };
    }
  });
}

// ---------------------------------------------------------------------------
// Scryfall-Zuordnung
// ---------------------------------------------------------------------------

export function applyScryfallMappings(db: Db, mappings: Iterable<ScryfallMapping>): { mapped: number; conflicts: number } {
  const now = nowIso();
  const seen = new Map<number, ScryfallMapping>();
  const ambiguous = new Set<number>();
  for (const m of mappings) {
    const prev = seen.get(m.cardmarketId);
    if (!prev) { seen.set(m.cardmarketId, m); continue; }
    // Mehrere Scryfall-Drucke mit derselben Cardmarket-ID und abweichendem Set/Nummer → als mehrdeutig markieren.
    if (prev.setCode !== m.setCode || prev.collectorNumber !== m.collectorNumber) ambiguous.add(m.cardmarketId);
  }
  let mapped = 0;
  db.tx(() => {
    const st = db.raw.prepare(`UPDATE products SET set_code = ?, set_name = ?, collector_number = ?, rarity = ?, image_url = ?,
      scryfall_id = ?, finishes = ?, mapping_status = ?, updated_at = ? WHERE game_id = 'mtg' AND source = 'cardmarket' AND external_id = ?`);
    for (const m of seen.values()) {
      const status = ambiguous.has(m.cardmarketId) ? 'ambiguous' : 'mapped';
      mapped += Number(st.run(m.setCode, m.setName, m.collectorNumber, m.rarity, m.imageUrl, m.scryfallId, m.finishes.join(','), status, now, m.cardmarketId).changes);
    }
    // Editionen aus den zugeordneten Produkten ableiten (Mehrheitsentscheid je Cardmarket-Expansion)
    db.exec(`
      INSERT OR REPLACE INTO expansions (game_id, source, external_id, code, name, released_at)
      SELECT 'mtg', 'cardmarket', expansion_external_id, set_code, set_name, NULL FROM (
        SELECT expansion_external_id, set_code, set_name, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY expansion_external_id ORDER BY COUNT(*) DESC) AS rn
        FROM products WHERE mapping_status = 'mapped' AND expansion_external_id IS NOT NULL
        GROUP BY expansion_external_id, set_code, set_name)
      WHERE rn = 1`);
    // Nicht direkt zugeordnete Produkte bekommen zumindest den Editionsnamen
    db.run(`UPDATE products SET set_code = e.code, set_name = e.name, mapping_status = 'expansion_only', updated_at = ?
            FROM expansions e WHERE e.game_id = products.game_id AND e.source = 'cardmarket' AND e.external_id = products.expansion_external_id
              AND products.mapping_status = 'unmapped'`, [now]);
  });
  return { mapped, conflicts: ambiguous.size };
}

export function importScryfall(ctx: AppContext): Promise<ImportResult> {
  return exclusive(async () => {
    const { db } = ctx;
    const id = startRun(db, 'scryfall');
    try {
      const info = await resolveBulkDownload(ctx.providers.scryfallBulkUrl);
      const file = join(ctx.cfg.rawDir, info.gz ? 'scryfall-default-cards.jsonl.gz' : 'scryfall-default-cards.json');
      log.info(`Scryfall: lade ${info.url}`);
      await downloadToFile(info.url, file);
      const all: ScryfallMapping[] = [];
      const stats = await readBulkFile(file, info.gz, m => all.push(m));
      const r = applyScryfallMappings(db, all);
      const res = {
        status: 'success' as const, rows: stats.lines, written: r.mapped, createdAt: info.updatedAt,
        message: `${stats.lines} Karten gelesen, ${r.mapped} Cardmarket-Produkte zugeordnet` +
          (r.conflicts ? `, ${r.conflicts} mehrdeutige IDs` : '') + (stats.errors ? `, ${stats.errors} fehlerhafte Zeilen` : ''),
      };
      finishRun(db, id, res);
      log.info(`Scryfall: ${res.message}`);
      return { source: 'scryfall' as const, ...res };
    } catch (e) {
      const res = { status: 'failed' as const, message: (e as Error).message };
      finishRun(db, id, res);
      log.error('Scryfall-Import fehlgeschlagen', e);
      return { source: 'scryfall' as const, ...res };
    }
  });
}

// ---------------------------------------------------------------------------
// Status der Datenquellen
// ---------------------------------------------------------------------------

export interface SourceStatus {
  source: ImportSource;
  label: string;
  lastSuccessAt: string | null;
  dataCreatedAt: string | null;
  ageHours: number | null;
  stale: boolean;
  lastRun: { status: string; startedAt: string; finishedAt: string | null; message: string | null } | null;
  failing: boolean;
}

export function sourceStatus(ctx: AppContext, now = Date.now()): SourceStatus[] {
  const s = ctx.settings.get();
  const defs: { source: ImportSource; label: string; staleHours: number }[] = [
    { source: 'cardmarket_price_guide', label: 'Cardmarket Price Guide', staleHours: s.analysis.staleGuideHours },
    { source: 'cardmarket_catalog', label: 'Cardmarket Produktkatalog', staleHours: 24 * 7 },
    { source: 'scryfall', label: 'Scryfall Zuordnung', staleHours: 24 * (s.scheduler.scryfallRefreshDays * 2) },
  ];
  return defs.map(d => {
    const ok = lastSuccess(ctx.db, d.source);
    const last = ctx.db.get<{ status: string; started_at: string; finished_at: string | null; message: string | null }>(
      'SELECT status, started_at, finished_at, message FROM import_runs WHERE source = ? ORDER BY id DESC LIMIT 1', [d.source]);
    const ref = ok?.source_created_at ?? ok?.finished_at ?? null;
    const age = ref ? (now - Date.parse(ref)) / 36e5 : null;
    return {
      source: d.source, label: d.label,
      lastSuccessAt: ok?.finished_at ?? null,
      dataCreatedAt: ok?.source_created_at ?? null,
      ageHours: age == null ? null : Math.round(age * 10) / 10,
      stale: age == null || age > d.staleHours,
      lastRun: last ? { status: last.status, startedAt: last.started_at, finishedAt: last.finished_at, message: last.message } : null,
      failing: last?.status === 'failed',
    };
  });
}
