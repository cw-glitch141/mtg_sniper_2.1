/**
 * Live-Deal-Radar: Feed-Status, CardTrader-Adapter (gegen aufgezeichnete Antwortformen), Grundlinie,
 * neue/reduzierte Angebote, Alarme, Test-Feed, Market-Watch-Trennung, Qualitätsbericht, Migration.
 * Kein Test spricht mit dem echten Internet.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Db, openDb } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { cardtraderProvider, mapCardTraderProduct } from '../src/providers/cardtrader.ts';
import { mapCondition } from '../src/providers/listings.ts';
import { mockListingProvider } from '../src/providers/mockListings.ts';
import { formatAlertText, listAlerts, payloadFromOpportunity } from '../src/services/alerts.ts';
import { queryOpportunities } from '../src/services/analysis.ts';
import { importPriceGuide } from '../src/services/importer.ts';
import { liveStatus, NOT_AVAILABLE, pollProvider, rankTargets, validateListing } from '../src/services/liveRadar.ts';
import { ingestOffers, listOffers } from '../src/services/offers.ts';
import { runPipeline } from '../src/services/pipeline.ts';
import { alertOperator, buildQualityReport, renderQualityMarkdown, saveQualityReport } from '../src/services/qualityReport.ts';
import { testApp, type TestApp } from './helpers.ts';

// ---------------------------------------------------------------- Fake CardTrader-API (Antwortformen laut Recherche)

interface CtListing { id: number; price: number; cond?: string; lang?: string; foil?: boolean; seller?: string; country?: string; vacation?: boolean; signed?: boolean; currency?: string }
function fakeCardTrader() {
  const state = {
    listings: new Map<string, CtListing[]>(), // key `${blueprint}:${foil}`
    calls: [] as string[],
    rateLimitMarketplace: false,
  };
  const product = (bp: number, l: CtListing) => ({
    id: l.id, blueprint_id: bp, name_en: 'x', quantity: 1, bundle_size: 1, graded: false, on_vacation: !!l.vacation,
    price: { cents: Math.round(l.price * 100), currency: l.currency ?? 'EUR' },
    properties_hash: { condition: l.cond ?? 'Near Mint', mtg_language: l.lang ?? 'en', mtg_foil: !!l.foil, signed: !!l.signed, altered: false },
    user: { id: 1, username: l.seller ?? 'CtSeller', country_code: l.country ?? 'DE', user_type: 'professional', can_sell_via_hub: true },
  });
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/v2', '');
    state.calls.push(path + url.search);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/expansions') return json([{ id: 45, game_id: 1, code: 'mrd', name: 'Mirrodin' }, { id: 99, game_id: 4, code: 'mrd', name: 'anderes Spiel' }]);
    if (path === '/blueprints/export') {
      return json([
        { id: 5001, game_id: 1, expansion_id: 45, card_market_ids: [152] },
        { id: 5002, game_id: 1, expansion_id: 45, card_market_ids: [1001] },
      ]);
    }
    if (path === '/marketplace/products') {
      if (state.rateLimitMarketplace) return json({ error: 'Too many requests: max 200 requests per 10 seconds' }, 429);
      const bp = url.searchParams.get('blueprint_id') as string;
      const foil = url.searchParams.get('foil') === 'true';
      return json({ [bp]: (state.listings.get(`${bp}:${foil}`) ?? []).map(l => product(Number(bp), l)) });
    }
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;
  return { state, fetchImpl };
}

describe('Live-Deal-Radar', () => {
  let t: TestApp;
  let base = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-MTGDS-Token': t.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json: json as never, text };
  };

  before(async () => {
    t = testApp();
    await runPipeline(t.ctx, { scryfall: false });
    t.ctx.db.run("UPDATE products SET set_code = 'mrd', set_name = 'Mirrodin' WHERE external_id IN (152, 1001)");
    await new Promise<void>(r => t.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(t.server.address() as AddressInfo).port}`;
  });
  after(async () => { await t.cleanup(); });

  it('Ohne Feed: ehrliche Meldung, keine automatischen Live-Angebote', async () => {
    const st = liveStatus(t.ctx);
    assert.equal(st.available, false);
    assert.equal(st.headline, NOT_AVAILABLE);
    assert.equal(st.monitorsCardmarket, false);
    const ct = t.ctx.providers.listings.find(p => p.id === 'api:cardtrader');
    assert.ok(ct, 'CardTrader-Adapter ist registriert (aber nicht angeschlossen)');
    const r = await pollProvider(t.ctx, ct);
    assert.equal(r.status, 'not_ready');
    assert.match(r.message, /CARDTRADER_TOKEN/);
    assert.equal(listOffers(t.ctx.db, { includeSimulation: true }).length, 0);
    const status = await call('GET', '/api/status');
    assert.ok((status.json as unknown as { warnings: string[] }).warnings.includes(NOT_AVAILABLE));
  });

  it('CardTrader nur mit eigenem Token UND bestätigten Bedingungen bereit', () => {
    const fake = fakeCardTrader();
    let token: string | null = 'eigenes-token';
    const p = cardtraderProvider({ db: t.ctx.db, token: () => token, settings: () => t.ctx.settings.get().live.cardtrader, fetchImpl: fake.fetchImpl, sleep: async () => {} });
    assert.equal(p.readiness().authorized, false);
    assert.match(p.readiness().reason ?? '', /deaktiviert/);
    t.ctx.settings.update({ live: { cardtrader: { enabled: true } } });
    assert.match(p.readiness().reason ?? '', /Nutzungsbedingungen/);
    t.ctx.settings.update({ live: { cardtrader: { termsConfirmed: true } } });
    assert.deepEqual(p.readiness(), { configured: true, authorized: true, reason: null });
    token = null;
    assert.equal(p.readiness().configured, false);
    assert.equal(t.ctx.settings.update({ live: { cardtrader: { maxRequestsPerSecond: 50 } } }).errors.length, 1, 'über dem dokumentierten Limit');
  });

  it('Abbildung: Zustand, Sprache, Finish, Flags, Preis in Cent', () => {
    assert.equal(mapCondition('Near Mint'), 'NM');
    assert.equal(mapCondition('Slightly Played'), 'EX');
    assert.equal(mapCondition('irgendwas'), null);
    const rec = mapCardTraderProduct({ id: 7, blueprint_id: 5001, price: { cents: 1234, currency: 'EUR' }, properties_hash: { condition: 'Mint', mtg_language: 'jp', mtg_foil: true, signed: true }, user: { username: 'u', country_code: 'IT' } },
      { productId: 1, externalId: 152, finish: 'foil', name: 'Chrome Mox', setCode: 'mrd', collectorNumber: null }, 'https://www.cardtrader.com/cards/{blueprint_id}', new Date().toISOString());
    assert.deepEqual([rec.price, rec.currency, rec.condition, rec.language, rec.finish, rec.listingId, rec.listingUrl], [12.34, 'EUR', 'MT', 'ja', 'foil', '7', 'https://www.cardtrader.com/cards/5001']);
    assert.ok(rec.flags.includes('signiert'));
    assert.equal(validateListing(rec, 'foil').status, 'review');
    assert.equal(validateListing({ ...rec, currency: 'USD' }, 'foil').status, 'reject');
    assert.equal(validateListing({ ...rec, flags: ['Verkäufer im Urlaub'] }, 'foil').status, 'reject');
  });

  it('Zielmenge: Preisband, belegte Verkäufe, keine Ausreißer', () => {
    const targets = rankTargets(t.ctx.db, t.ctx.settings.get());
    const names = targets.map(x => `${x.name}:${x.finish}`);
    assert.ok(names.includes('Chrome Mox:nonfoil') && names.includes('Chrome Mox:foil') && names.includes('Test Dip Card:nonfoil'));
    assert.ok(!names.some(n => n.startsWith('Outlier') || n.startsWith('Cheap')), names.join(','));
  });

  it('CardTrader: Grundlinie ohne Alarm, danach neues Angebot + Preissenkung → LIVE-ANGEBOT-Alarm mit Link', async () => {
    const fake = fakeCardTrader();
    const p = cardtraderProvider({ db: t.ctx.db, token: () => 'eigenes-token', settings: () => t.ctx.settings.get().live.cardtrader, fetchImpl: fake.fetchImpl, sleep: async () => {} });
    fake.state.listings.set('5001:false', [{ id: 1, price: 90 }, { id: 2, price: 95, seller: 'Zweiter' }, { id: 3, price: 30, vacation: true }]);
    fake.state.listings.set('5001:true', [{ id: 10, price: 170, foil: true }]);
    fake.state.listings.set('5002:false', [{ id: 20, price: 45 }]);

    const r1 = await pollProvider(t.ctx, p);
    assert.equal(r1.status, 'success', r1.message);
    assert.equal(r1.covered, 3);
    assert.equal(r1.baselineTargets, 3);
    assert.equal(r1.rejected, 1, 'Verkäufer im Urlaub wird nicht übernommen');
    assert.equal(r1.newListings, 0, 'Grundlinie erzeugt keine "neuen" Angebote');
    assert.equal(r1.alerts, 0);
    assert.ok(fake.state.calls.some(c => c.startsWith('/blueprints/export?expansion_id=45')));

    fake.state.listings.set('5001:false', [{ id: 1, price: 90 }, { id: 2, price: 80, seller: 'Zweiter' }, { id: 3, price: 30, vacation: true }, { id: 4, price: 50, seller: 'NeuerHändler' }]);
    const r2 = await pollProvider(t.ctx, p);
    assert.equal(r2.newListings, 1);
    assert.equal(r2.priceDrops, 1);
    assert.equal(r2.alerts, 1, r2.message);
    const callsBefore = fake.state.calls.filter(c => c.startsWith('/blueprints')).length;
    assert.equal(callsBefore, 1, 'Blueprint-Zuordnung wird zwischengespeichert');

    const al = listAlerts(t.ctx.db, { kind: 'live_offer' })[0];
    assert.equal(al.signalClass, 'LIVE_OFFER');
    assert.equal(al.payload.url, 'https://www.cardtrader.com/cards/5001');
    assert.equal(al.payload.listingId, '4');
    assert.equal(al.payload.seller, 'NeuerHändler');
    assert.equal(al.payload.condition, 'NM');
    assert.ok(al.payload.labels?.includes('LIVE-ANGEBOT'));
    assert.ok((al.payload.profitConservative ?? 0) > 0);
    const text = formatAlertText(al as never);
    assert.match(text, /Angebots-ID 4/);
    assert.match(text, /Gewinn konservativ/);
    assert.match(text, /Vor der Zahlung auf der Angebotsseite prüfen/);

    const ev = (await call('GET', '/api/live/events')).json as unknown as { type: string; latencyMs: number | null; latencyBasis: string | null; alertId: number | null; listingId: string }[];
    const fresh = ev.find(e => e.listingId === '4');
    assert.equal(fresh?.type, 'new_listing');
    assert.equal(fresh?.latencyBasis, 'poll_window_upper_bound');
    assert.ok(fresh?.alertId);
    assert.ok(ev.some(e => e.type === 'price_drop' && e.listingId === '2'));

    const r3 = await pollProvider(t.ctx, p);
    assert.equal(r3.newListings + r3.priceDrops + r3.alerts, 0, 'unverändert → keine Doppelalarme');

    const st = liveStatus(t.ctx);
    // Der Fake-Adapter ist nicht in ctx.providers registriert → zählt nicht als verbundener Feed.
    assert.equal(st.available, false);
  });

  it('Rate-Limit (HTTP 429) bricht den Lauf ab und wird protokolliert', async () => {
    const fake = fakeCardTrader();
    fake.state.rateLimitMarketplace = true;
    const p = cardtraderProvider({ db: t.ctx.db, token: () => 'eigenes-token', settings: () => t.ctx.settings.get().live.cardtrader, fetchImpl: fake.fetchImpl, sleep: async () => {} });
    const r = await pollProvider(t.ctx, p);
    assert.equal(r.rateLimited, true);
    assert.equal(r.status, 'failed');
    assert.equal(fake.state.calls.filter(c => c.startsWith('/marketplace')).length, 1, 'nach 429 keine weiteren Anfragen');
    const run = t.ctx.db.get<{ rate_limited: number }>('SELECT rate_limited FROM live_poll_runs WHERE id = ?', [r.runId]);
    assert.equal(run?.rate_limited, 1);
  });

  it('TEST-Feed erzeugt nur SIMULATION, nie externe Zustellung, Status bleibt "nicht verfügbar"', async () => {
    const mock = mockListingProvider(x => t.ctx.db.get<{ trend: number }>("SELECT trend FROM price_latest WHERE product_id = ? AND finish = ?", [x.productId, x.finish])?.trend ?? null);
    t.ctx.providers.listings.push(mock);
    try {
      t.ctx.settings.update({ alerts: { channels: { telegram: true } } });
      await pollProvider(t.ctx, mock);
      const r2 = await pollProvider(t.ctx, mock);
      assert.ok(r2.newListings >= 1);
      const sims = listAlerts(t.ctx.db, { signalClass: 'SIMULATION' });
      assert.ok(sims.length >= 1);
      assert.ok(sims.every(a => /^TEST · /.test(String(a.title)) && !('telegram' in a.deliveries)));
      assert.ok(listOffers(t.ctx.db, { includeSimulation: true }).filter(o => o.source === 'test:mock-feed').every(o => o.signalClass === 'SIMULATION'));
      const st = liveStatus(t.ctx);
      assert.equal(st.available, false);
      assert.ok(st.headline.startsWith(NOT_AVAILABLE) && /TEST-Feed/.test(st.headline));
    } finally {
      t.ctx.settings.update({ alerts: { channels: { telegram: false } } });
      t.ctx.providers.listings.pop();
    }
  });

  it('Angebot ohne Link → nur PRÜFEN; veraltetes Feed-Angebot → VERALTET, keine Kaufchance', async () => {
    const res = ingestOffers(t.ctx, 'extension', 'LIVE_OFFER', [
      { externalId: 'nolink', productExternalId: 152, price: 50, condition: 'NM', language: 'en', seller: 'S', sellerCountry: 'DE' },
    ]);
    const { evaluateOffer } = await import('../src/services/offers.ts');
    const o = evaluateOffer(t.ctx, listOffers(t.ctx.db, { ids: res.offerIds })[0])!;
    assert.equal(o.rules.passed, true, o.rules.failures.join('; '));
    assert.equal(o.recommendation, 'PRÜFEN');
    assert.deepEqual(o.listingCheck.missing, ['Link zum Angebot']);

    const old = new Date(Date.now() - 3 * 36e5).toISOString();
    const r2 = ingestOffers(t.ctx, 'api:cardtrader', 'LIVE_OFFER', [
      { externalId: 'old-1', productExternalId: 152, price: 50, condition: 'NM', language: 'en', seller: 'S', sellerCountry: 'DE', url: 'https://www.cardtrader.com/cards/5001', observedAt: old, currency: 'EUR' },
    ]);
    const o2 = evaluateOffer(t.ctx, listOffers(t.ctx.db, { ids: r2.offerIds })[0])!;
    assert.equal(o2.stale, true);
    assert.ok(o2.labels.includes('VERALTET'));
    assert.notEqual(o2.recommendation, 'KAUFEN');
  });

  it('Fremde Währung wird beim Eingang abgelehnt (keine stille Umrechnung)', () => {
    const r = ingestOffers(t.ctx, 'api:cardtrader', 'LIVE_OFFER', [{ externalId: 'usd', productExternalId: 152, price: 50, currency: 'USD' }]);
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reason, /USD/);
  });

  it('Market Watch: Marktsignale ohne Einkaufspreis und Gewinn – in Alarm, CSV und Kaufentscheidung', async () => {
    await call('POST', '/api/analyze', {});
    const m = queryOpportunities(t.ctx.db, { signalClass: 'MARKET_SIGNAL', limit: 5 }).items[0];
    assert.ok(m, 'Testdaten enthalten ein Marktsignal');
    assert.equal(m.evidence, 'market_model');
    assert.equal(m.buy.hypothetical, true);
    assert.match(m.buy.label, /^Modellwert \(hypothetisch\)/);
    const p = payloadFromOpportunity(m);
    assert.equal(p.buyPrice, undefined);
    assert.equal(p.profit, undefined);
    const text = formatAlertText({ signalClass: 'MARKET_SIGNAL', priority: 'MEDIUM', title: 'x', message: '', payload: p });
    assert.doesNotMatch(text, /Einkauf|Gewinn/);
    assert.match(text, /Modellwert \(hypothetisch\)/);

    const csv = await (await fetch(base + '/api/opportunities.csv?signalClass=MARKET_SIGNAL')).text();
    const [head, first] = csv.replace(/^﻿/, '').split('\r\n');
    const cols = head.split(';');
    const row = first.split(';');
    assert.equal(row[cols.indexOf('Einkauf inkl. Porto (nur Angebote)')], '');
    assert.equal(row[cols.indexOf('Gewinn Basis')], '');
    assert.notEqual(row[cols.indexOf('Modellwert (hypothetisch, nur Marktsignale)')], '');

    const d = await call('POST', '/api/decisions', { opportunityKey: m.key, decision: 'accepted', confirmedAvailable: true });
    assert.equal(d.status, 400);
    assert.match(d.text, /kein Angebot/);
  });

  it('Rückwärtskompatibilität: Extension-Nutzlast im Originalformat (shared.js) wird weiter angenommen', async () => {
    const offer = { externalId: 'articleRow77', productExternalId: 152, productName: null, expansionName: null, finish: 'nonfoil', condition: 'NM', language: 'en',
      price: 52, amount: 1, seller: 'ExtSeller', sellerCountry: 'Deutschland', sellerType: 'pro', sellerSales: 1200,
      url: 'https://www.cardmarket.com/de/Magic/Products/Singles/Mirrodin/Chrome-Mox', observedAt: new Date().toISOString() };
    const r = await call('POST', '/api/offers', { source: 'extension', offers: [offer] });
    assert.equal(r.status, 200, r.text);
    const j = r.json as unknown as { inserted: number; evaluations: { recommendation: string }[] };
    assert.equal(j.inserted, 1);
    assert.equal(j.evaluations[0].recommendation, 'KAUFEN');
  });

  it('Qualitätsbericht: Befunde priorisiert, Tests fließen ein, Trend ggü. Vorbericht', () => {
    const a = buildQualityReport(t.ctx);
    assert.ok(a.findings.some(f => f.code === 'no_live_feed'));
    assert.ok(a.findings.some(f => f.code === 'tests_unknown'));
    saveQualityReport(t.ctx.db, a);
    const b = buildQualityReport(t.ctx, { tests: { total: 10, passed: 9, failed: 1, typecheck: 'ok', at: new Date().toISOString() } });
    assert.equal(b.status, 'critical');
    assert.equal(b.findings[0].code, 'tests_failed');
    assert.ok(b.trend.previousAt);
    const md = renderQualityMarkdown(b);
    assert.match(md, /^# Qualitätsbericht/);
    assert.match(md, /## Befunde und Vorschläge \(priorisiert\)/);
    assert.match(md, /## Fehlalarm-Indikatoren/);
  });
});

describe('Betreiber-Warnung bei Datenausfall (US-05)', () => {
  let t: TestApp;
  before(async () => { t = testApp(); await runPipeline(t.ctx, { scryfall: false }); });
  after(async () => { await t.cleanup(); });

  it('Fehlgeschlagener Price-Guide-Import erzeugt einen SYSTEM-Alarm (einmal je Tag)', async () => {
    t.sources.fail = true;
    await importPriceGuide(t.ctx, true);
    t.sources.fail = false;
    assert.equal(await alertOperator(t.ctx), 1);
    assert.equal(await alertOperator(t.ctx), 0, 'Dedupe');
    const sys = listAlerts(t.ctx.db, { signalClass: 'SYSTEM' });
    assert.equal(sys.length, 1);
    assert.equal(sys[0].signalLabel, 'SYSTEM');
    assert.match(String(sys[0].title), /Price Guide/);
  });
});

describe('Migration 3 ist additiv', () => {
  it('bestehende Angebote bleiben erhalten, Sicherung wird angelegt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mtgds-mig-'));
    try {
      const file = join(dir, 'old.sqlite');
      const db = new Db(file);
      db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const m of MIGRATIONS.filter(x => x.id <= 2)) {
        db.exec(m.sql);
        m.up?.(db);
        db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, new Date().toISOString()]);
      }
      db.run(`INSERT INTO offers (source, signal_class, external_id, finish, price, first_seen_at, observed_at, seller)
              VALUES ('extension', 'LIVE_OFFER', 'alt-1', 'nonfoil', 12.5, '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z', 'AltHändler')`);
      db.close();
      const migrated = openDb(file);
      const row = migrated.get<{ price: number; seller: string; currency: string | null; review_status: string | null }>("SELECT price, seller, currency, review_status FROM offers WHERE external_id = 'alt-1'");
      assert.deepEqual({ ...row }, { price: 12.5, seller: 'AltHändler', currency: null, review_status: null });
      assert.equal(migrated.get<{ n: number }>('SELECT MAX(id) AS n FROM schema_migrations')?.n, MIGRATIONS.at(-1)?.id);
      migrated.close();
      assert.ok(existsSync(join(dir, 'backups')) && readdirSync(join(dir, 'backups')).some(f => f.startsWith('mtgds-before-migration-3')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
