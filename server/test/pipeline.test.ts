import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { normalizeTs, snapshotDate, sourceStatus } from '../src/services/importer.ts';
import { ingestOffers, parseOfferCsv } from '../src/services/offers.ts';
import { runPipeline } from '../src/services/pipeline.ts';
import { queryOpportunities } from '../src/services/analysis.ts';
import { importLegacyWatchlist, listWatch } from '../src/services/watchlist.ts';
import { parsePriceGuide } from '../src/providers/cardmarketS3.ts';
import { dayOffset, testApp, type TestApp } from './helpers.ts';

describe('Import-Pipeline (mit Testquellen)', () => {
  let t: TestApp;
  before(() => { t = testApp(); });
  after(async () => { await t.cleanup(); });

  it('Zeitstempel der Quelle werden korrekt übernommen', () => {
    assert.equal(normalizeTs('2026-11-04T02:47:21+0100'), '2026-11-04T02:47:21+01:00');
    assert.equal(snapshotDate('2026-11-04T02:47:21+0100'), '2026-11-04');
  });

  it('Parser: fehlende Preise bleiben null (nicht 0)', () => {
    const p = parsePriceGuide({ createdAt: 'x', priceGuides: [{ idProduct: 1, idCategory: 1, avg: null, low: 0, trend: 2 }] });
    assert.equal(p.items[0].nonfoil.avg, null);
    assert.equal(p.items[0].nonfoil.low, null);
    assert.equal(p.items[0].nonfoil.trend, 2);
    assert.throws(() => parsePriceGuide({} as never), /unerwartetes Format/);
  });

  it('importiert Katalog und Price Guide, verknüpft über IDs, historisiert ab Preisgrenze', async () => {
    const r = await runPipeline(t.ctx, { scryfall: false });
    assert.deepEqual(r.imports.map(i => i.status), ['success', 'success']);
    const db = t.ctx.db;
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM products')?.n, 4);
    // 152 nonfoil+foil, 1001, 1002, 1003 nonfoil = 5 Preisreihen; Nicht-Single übersprungen
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM price_latest')?.n, 5);
    // Cheap Card (0,50 €) liegt unter historyMinPrice (2 €) → kein Snapshot
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM price_snapshots s JOIN products p ON p.id = s.product_id WHERE p.external_id = 1002")?.n, 0);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM price_snapshots')?.n, 4);
    const foil = db.get<{ avg30: number }>("SELECT l.avg30 FROM price_latest l JOIN products p ON p.id = l.product_id WHERE p.external_id = 152 AND l.finish = 'foil'");
    assert.equal(foil?.avg30, 180.99);
    assert.ok(r.analysis && r.analysis.opportunities >= 1);
  });

  it('gleicher Datenstand wird nicht doppelt importiert', async () => {
    const r = await runPipeline(t.ctx, { scryfall: false });
    assert.equal(r.imports.find(i => i.source === 'cardmarket_price_guide')?.status, 'skipped');
    assert.equal(r.analysis, null);
  });

  it('neuer Tag → zweiter Snapshot, echte Veränderungen werden berechnet', async () => {
    t.sources.setDay(dayOffset(1), { 1001: { trend: 34, avg1: 28, avg7: 36, avg30: 39 } });
    await runPipeline(t.ctx, { scryfall: false });
    const days = t.ctx.db.get<{ n: number }>('SELECT COUNT(DISTINCT snapshot_date) AS n FROM price_snapshots')?.n;
    assert.equal(days, 2);
  });

  it('Unplausible Aggregate erzeugen keine Marktsignale', () => {
    const res = queryOpportunities(t.ctx.db, { q: 'Outlier', limit: 10 });
    assert.equal(res.total, 0);
  });

  it('Marktsignale werden nie als KAUFEN empfohlen', () => {
    const res = queryOpportunities(t.ctx.db, { signalClass: 'MARKET_SIGNAL', limit: 100 });
    assert.ok(res.total > 0);
    assert.ok(res.items.every(o => o.recommendation !== 'KAUFEN'));
  });

  it('Ausfall einer Quelle wird protokolliert und angezeigt, alte Daten bleiben nutzbar', async () => {
    t.sources.fail = true;
    t.sources.setDay(dayOffset(2));
    const r = await runPipeline(t.ctx, { scryfall: false });
    t.sources.fail = false;
    assert.equal(r.imports.find(i => i.source === 'cardmarket_price_guide')?.status, 'failed');
    const st = sourceStatus(t.ctx).find(s => s.source === 'cardmarket_price_guide');
    assert.equal(st?.failing, true);
    assert.ok(st?.lastSuccessAt);
    assert.equal(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM price_latest')?.n, 5);
  });

  it('Angebote: Dubletten, Preisänderung, Zuordnung über Produkt-ID', () => {
    const base = { externalId: 'articleRow1', productExternalId: 152, price: 60, condition: 'NM', language: 'en', seller: 'A', sellerCountry: 'Deutschland' };
    const r1 = ingestOffers(t.ctx, 'extension', 'LIVE_OFFER', [base, { ...base, externalId: 'articleRow2', productExternalId: 424242 }, { price: -1 } as never]);
    assert.equal(r1.inserted, 2);
    assert.equal(r1.unmatched, 1);
    assert.equal(r1.rejected.length, 1);
    const r2 = ingestOffers(t.ctx, 'extension', 'LIVE_OFFER', [{ ...base, price: 55 }]);
    assert.equal(r2.inserted, 0);
    assert.equal(r2.priceChanged, 1);
    const row = t.ctx.db.get<{ price: number; previous_price: number }>("SELECT price, previous_price FROM offers WHERE external_id = 'articleRow1'");
    assert.deepEqual({ ...row }, { price: 55, previous_price: 60 });
  });

  it('CSV-Import (deutsches Format)', () => {
    const csv = 'idProduct;Name;Preis;Zustand;Sprache;Foil;Verkäufer\n152;Chrome Mox;"1.234,50";NM;de;nein;X\n;Chrome Mox;abc;NM;de;;Y';
    const r = parseOfferCsv(csv);
    assert.equal(r.offers.length, 1);
    assert.equal(r.offers[0].price, 1234.5);
    assert.equal(r.offers[0].finish, 'nonfoil');
    assert.equal(r.errors.length, 1);
  });

  it('Watchlist-Migration aus der Extension ist idempotent', () => {
    const entries = [{ key: 'chromemox', name: 'Chrome Mox', qty: 2, target: 70, bought: false }, { name: '' }];
    const a = importLegacyWatchlist(t.ctx.db, entries);
    const b = importLegacyWatchlist(t.ctx.db, entries);
    assert.deepEqual(a, { imported: 1, merged: 0, skipped: 1 });
    assert.deepEqual(b, { imported: 0, merged: 1, skipped: 1 });
    const w = listWatch(t.ctx.db);
    assert.equal(w.length, 1);
    assert.equal(w[0].qty, 2);
    assert.equal(w[0].targetPrice, 70);
  });
});
