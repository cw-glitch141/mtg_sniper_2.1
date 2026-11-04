import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app.ts';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/domain/settings.ts';
import type { GuidePrices } from '../src/domain/types.ts';
import { parsePriceGuide, parseProductList } from '../src/providers/cardmarketS3.ts';
import type { CatalogProvider, PriceProvider } from '../src/providers/types.ts';
import { configureLog } from '../src/util/log.ts';

configureLog({ quiet: true, file: null });

export function settings(patch: (s: AppSettings) => void = () => {}): AppSettings {
  const s = structuredClone(DEFAULT_SETTINGS);
  patch(s);
  return s;
}

export function guide(p: Partial<GuidePrices>): GuidePrices {
  return { avg: null, low: null, trend: null, avg1: null, avg7: null, avg30: null, sourceCreatedAt: new Date().toISOString(), ...p };
}

/** Kleiner Katalog im Originalformat von products_singles_1.json. */
export const CATALOG = {
  version: 1, createdAt: '2026-11-04T13:23:33+0100',
  products: [
    { idProduct: 152, name: 'Chrome Mox', idCategory: 1, categoryName: 'Magic Single', idExpansion: 45, idMetacard: 976, dateAdded: '2007-01-01 00:00:00' },
    { idProduct: 1001, name: 'Test Dip Card', idCategory: 1, categoryName: 'Magic Single', idExpansion: 45, idMetacard: 1, dateAdded: '2020-01-01 00:00:00' },
    { idProduct: 1002, name: 'Cheap Card', idCategory: 1, categoryName: 'Magic Single', idExpansion: 45, idMetacard: 2, dateAdded: '2020-01-01 00:00:00' },
    { idProduct: 1003, name: 'Outlier Card', idCategory: 1, categoryName: 'Magic Single', idExpansion: 46, idMetacard: 3, dateAdded: '2020-01-01 00:00:00' },
  ],
};

/** Price Guide im Originalformat. `day` verschiebt createdAt und erlaubt mehrere Import-Tage. */
export function priceGuideFor(day: string, overrides: Record<number, Record<string, number | null>> = {}) {
  const base: Record<number, Record<string, number | null>> = {
    152: { avg: 84.56, low: 59, trend: 86.43, avg1: 75.34, avg7: 84.75, avg30: 83.67, 'avg-foil': 163.98, 'low-foil': 105, 'trend-foil': 159.91, 'avg1-foil': 170, 'avg7-foil': 158.89, 'avg30-foil': 180.99 },
    1001: { avg: 40, low: 30, trend: 40, avg1: 25, avg7: 39, avg30: 40, 'avg-foil': null, 'low-foil': null, 'trend-foil': null, 'avg1-foil': null, 'avg7-foil': null, 'avg30-foil': null },
    1002: { avg: 0.5, low: 0.1, trend: 0.5, avg1: 0.4, avg7: 0.5, avg30: 0.5, 'avg-foil': null, 'low-foil': null, 'trend-foil': null, 'avg1-foil': null, 'avg7-foil': null, 'avg30-foil': null },
    1003: { avg: 300, low: 20, trend: 300, avg1: 20, avg7: 900, avg30: 1000, 'avg-foil': null, 'low-foil': null, 'trend-foil': null, 'avg1-foil': null, 'avg7-foil': null, 'avg30-foil': null },
  };
  const rows = Object.entries(base).map(([id, v]) => ({ idProduct: Number(id), idCategory: 1, ...v, ...(overrides[Number(id)] ?? {}) }));
  rows.push({ idProduct: 99999, idCategory: 2, avg: 10, low: 5, trend: 10 } as never); // Nicht-Single → wird übersprungen
  return { version: 1, createdAt: `${day}T02:47:21+0100`, priceGuides: rows };
}

export interface FakeSources { catalog: CatalogProvider; prices: PriceProvider; setDay(day: string, overrides?: Record<number, Record<string, number | null>>): void; fail: boolean }

/** Datum relativ zu heute (YYYY-MM-DD), damit Testdaten nie als veraltet gelten. */
export function dayOffset(n: number): string {
  return new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
}

export function fakeSources(): FakeSources {
  let pg = priceGuideFor(dayOffset(0));
  const fs: FakeSources = {
    fail: false,
    catalog: {
      id: 'cardmarket_catalog', gameId: 'mtg',
      async fetchCatalog() {
        const p = parseProductList(CATALOG);
        return { notModified: false, meta: { etag: 'c1', lastModified: null, status: 200 }, createdAt: p.createdAt, items: p.items, raw: JSON.stringify(CATALOG) };
      },
    },
    prices: {
      id: 'cardmarket_price_guide', gameId: 'mtg',
      async fetchPrices() {
        if (fs.fail) throw new Error('Simulierter Ausfall der Datenquelle');
        const p = parsePriceGuide(pg);
        return { notModified: false, meta: { etag: pg.createdAt, lastModified: null, status: 200 }, createdAt: p.createdAt, items: p.items, raw: JSON.stringify(pg) };
      },
    },
    setDay(day, overrides) { pg = priceGuideFor(day, overrides); },
  };
  return fs;
}

export interface TestApp extends App { dir: string; sources: FakeSources; cleanup(): Promise<void> }

export function testApp(): TestApp {
  const dir = mkdtempSync(join(tmpdir(), 'mtgds-test-'));
  const sources = fakeSources();
  const app = createApp({ cfg: { dataDir: dir, dbFile: join(dir, 'test.sqlite'), rawDir: join(dir, 'raw'), webDist: join(dir, 'no-dist'), port: 0 }, providers: { catalog: sources.catalog, prices: sources.prices }, scheduler: false });
  return {
    ...app, dir, sources,
    async cleanup() {
      await app.close().catch(() => undefined);
      try { app.ctx.db.close(); } catch { /* schon geschlossen */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
