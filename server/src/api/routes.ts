import { APP_NAME, APP_VERSION } from '../config.ts';
import { nowIso, parseJson } from '../db/database.ts';
import { breakEvenSellPrice, computeScenarios, computeTrade, maxBuyPrice } from '../analytics/profit.ts';
import { estimateResale } from '../analytics/resale.ts';
import { guideMetrics, historyMetrics } from '../analytics/stats.ts';
import { DEFAULT_SETTINGS } from '../domain/settings.ts';
import { shippingCost } from '../domain/shipping.ts';
import type { Finish } from '../domain/types.ts';
import type { OfferInput } from '../providers/types.ts';
import { listAlerts, dispatchAlerts } from '../services/alerts.ts';
import { getOpportunity, latestRunId, movers, queryOpportunities, type OpportunityQuery } from '../services/analysis.ts';
import { dealBundles, watchlistBundles } from '../services/bundles.ts';
import type { AppContext } from '../services/context.ts';
import { importCatalog, importPriceGuide, importScryfall, isImportRunning, sourceStatus } from '../services/importer.ts';
import { listDecisions, recordDecision } from '../services/journal.ts';
import { createPurchase } from '../services/purchases.ts';
import { buildExposure } from '../services/portfolio.ts';
import { logRecommendations } from '../services/analysis.ts';
import { evaluateOffer, ingestOffers, listOffers, parseOfferCsv } from '../services/offers.ts';
import { alertsForOffers, analyzeAndAlert, runPipeline, type Scheduler } from '../services/pipeline.ts';
import { getGuide, getHistory, getProduct, searchProducts } from '../services/products.ts';
import { clearSimulation, generateSimulation } from '../services/simulation.ts';
import { addWatch, deleteWatch, importLegacyWatchlist, listWatch, nameKey, updateWatch, validateWatch, type WatchInput } from '../services/watchlist.ts';
import { round2 } from '../util/num.ts';
import { ApiError, intParam, obj, optNum, Raw, type Router } from './http.ts';

function parseOppQuery(q: URLSearchParams): OpportunityQuery {
  const str = (k: string) => q.get(k) || undefined;
  return {
    q: str('q'), signalClass: str('signalClass'), strategy: str('strategy'), recommendation: str('recommendation'),
    finish: str('finish'), risk: str('risk'), priority: str('priority'),
    minScore: optNum(q, 'minScore'), minConfidence: optNum(q, 'minConfidence'), minProfit: optNum(q, 'minProfit'), minRoi: optNum(q, 'minRoi'),
    minPrice: optNum(q, 'minPrice'), maxPrice: optNum(q, 'maxPrice'), rulesPassed: q.get('rulesPassed') === '1',
    sort: (str('sort') as OpportunityQuery['sort']) ?? 'score', dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
    limit: optNum(q, 'limit'), offset: optNum(q, 'offset'),
  };
}

const csvNum = (v: number | null | undefined) => (v == null ? '' : String(v).replace('.', ','));
const csvStr = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function registerRoutes(r: Router, ctx: AppContext, scheduler: Scheduler | null, token: string): void {
  const { db } = ctx;
  const S = () => ctx.settings.get();

  // ------------------------------------------------------------------ Status
  r.get('/api/health', () => ({ ok: true, app: APP_NAME, version: APP_VERSION, time: nowIso() }));

  r.get('/api/status', () => {
    const sources = sourceStatus(ctx);
    const run = db.get<Record<string, unknown>>("SELECT id, started_at, finished_at, status, candidates, opportunities, data_date, message FROM analysis_runs ORDER BY id DESC LIMIT 1");
    const counts = db.get<Record<string, number>>(`SELECT
        (SELECT COUNT(*) FROM products) AS products,
        (SELECT COUNT(*) FROM products WHERE mapping_status = 'mapped') AS mapped,
        (SELECT COUNT(*) FROM price_latest) AS priceSeries,
        (SELECT COUNT(DISTINCT snapshot_date) FROM price_snapshots) AS historyDays,
        (SELECT COUNT(*) FROM price_snapshots) AS snapshots,
        (SELECT COUNT(*) FROM offers WHERE signal_class = 'LIVE_OFFER') AS liveOffers,
        (SELECT COUNT(*) FROM offers WHERE signal_class = 'SIMULATION') AS simulatedOffers,
        (SELECT COUNT(*) FROM watchlist WHERE bought = 0) AS watchOpen,
        (SELECT COUNT(*) FROM alerts WHERE read_at IS NULL) AS unreadAlerts`);
    const warnings: string[] = [];
    for (const s of sources) {
      if (s.failing) warnings.push(`${s.label}: letzter Import fehlgeschlagen – ${s.lastRun?.message ?? ''}`);
      else if (s.stale && s.source !== 'scryfall') warnings.push(`${s.label}: Daten veraltet oder noch nie importiert`);
    }
    if ((counts?.historyDays ?? 0) < 7) warnings.push(`Eigene Preishistorie umfasst erst ${counts?.historyDays ?? 0} Tag(e) – Historien-Kennzahlen (7/30 Tage, Volatilität) sind noch eingeschränkt.`);
    if (!counts?.liveOffers) warnings.push('Keine beobachteten Live-Angebote: Kaufempfehlungen entstehen erst mit Angeboten aus der Browser-Erweiterung oder dem manuellen Import. Marktsignale sind keine kaufbaren Angebote.');
    return {
      app: APP_NAME, version: APP_VERSION, now: nowIso(), sources, counts, warnings,
      analysis: run ?? null, importRunning: isImportRunning(),
      scheduler: scheduler ? { running: scheduler.running, lastTickAt: scheduler.lastTickAt, lastError: scheduler.lastError } : null,
      channels: {
        telegram: !!(ctx.cfg.secrets.telegramBotToken && ctx.cfg.secrets.telegramChatId),
        discord: !!ctx.cfg.secrets.discordWebhookUrl, email: false,
      },
      liveOfferProviders: ctx.providers.offers.map(p => p.id),
    };
  });

  r.get('/api/import-runs', c => db.all('SELECT * FROM import_runs ORDER BY id DESC LIMIT ?', [optNum(c.query, 'limit') ?? 50]));

  r.post('/api/import', async c => {
    const b = obj(c.body);
    const force = b.force === true;
    switch (b.source ?? 'all') {
      case 'catalog': return { imports: [await importCatalog(ctx, force)] };
      case 'prices': return { imports: [await importPriceGuide(ctx, force)] };
      case 'scryfall': return { imports: [await importScryfall(ctx)] };
      case 'all': return runPipeline(ctx, { force });
      default: throw new ApiError(400, 'source: all | catalog | prices | scryfall');
    }
  });

  r.post('/api/analyze', async () => analyzeAndAlert(ctx));

  // ------------------------------------------------------------------ Einstellungen
  r.get('/api/settings', () => ({ settings: S(), defaults: DEFAULT_SETTINGS }));
  r.put('/api/settings', c => {
    const out = ctx.settings.update(c.body);
    if (out.errors.length) throw new ApiError(400, 'Ungültige Einstellungen', out.errors);
    return { settings: out.settings };
  });
  r.post('/api/settings/reset', () => ({ settings: ctx.settings.reset() }));
  r.get('/api/token', c => {
    if (!c.sameOrigin) throw new ApiError(403, 'Token nur im Dashboard sichtbar');
    return { token };
  });

  // ------------------------------------------------------------------ Möglichkeiten / Ranking
  r.get('/api/opportunities', c => queryOpportunities(db, parseOppQuery(c.query)));
  r.get('/api/opportunities.csv', c => {
    const res = queryOpportunities(db, { ...parseOppQuery(c.query), limit: 2000 });
    const head = ['Karte', 'Edition', 'Set', 'Nr', 'Finish', 'Signaltyp', 'Strategie', 'Marktpreis (Trend)', 'Einkauf inkl. Porto', 'Verkauf konservativ',
      'Verkauf Basis', 'Verkauf optimistisch', 'Gewinn Basis', 'ROI Basis %', 'Rabatt %', 'Risiko', 'Confidence', 'Score', 'Empfehlung', 'Regeln erfüllt',
      'Zustand', 'Sprache', 'Verkäufer', 'Price-Guide-Stand', 'Beobachtet', 'Quelle', 'Angebotslink', 'Produktlink'];
    const lines = res.items.map(o => [
      csvStr(o.name), csvStr(o.setName), csvStr(o.setCode), csvStr(o.collectorNumber), o.finish, o.signalClass, csvStr(o.strategyLabel),
      csvNum(o.marketPrice), csvNum(o.buy.effective), csvNum(o.resale.conservative), csvNum(o.resale.base), csvNum(o.resale.optimistic),
      csvNum(o.scenarios.base?.profit), csvNum(o.scenarios.base?.roiPct), csvNum(o.discountPct), o.score.riskLevel, csvNum(o.score.confidence),
      csvNum(o.score.score), o.recommendation, o.rules.passed ? 'ja' : 'nein', o.buy.condition ?? '', o.buy.language ?? '', csvStr(o.buy.seller),
      o.dataDate ?? '', o.signalClass === 'MARKET_SIGNAL' ? '' : o.buy.observedAt, o.buy.source, o.buy.offerUrl ?? '', o.productUrl,
    ].join(';'));
    return new Raw('text/csv; charset=utf-8', '﻿' + [head.join(';'), ...lines].join('\r\n'), `mtgds-opportunities-${nowIso().slice(0, 10)}.csv`);
  });
  r.get('/api/opportunities/:key', c => {
    const o = getOpportunity(db, c.params.key);
    if (!o) throw new ApiError(404, 'Möglichkeit nicht (mehr) in der aktuellen Rangliste');
    return o;
  });

  r.get('/api/movers', c => {
    const w = Number(c.query.get('window') ?? 1);
    if (![1, 7, 30].includes(w)) throw new ApiError(400, 'window: 1 | 7 | 30');
    return movers(db, { window: w as 1 | 7 | 30, dir: c.query.get('dir') === 'up' ? 'up' : 'down', minPrice: optNum(c.query, 'minPrice') ?? S().rules.minPrice, maxRatio: S().analysis.maxReferenceRatio, limit: Math.min(optNum(c.query, 'limit') ?? 20, 200) });
  });

  // ------------------------------------------------------------------ Produkte
  r.get('/api/products/search', c => searchProducts(db, c.query.get('q') ?? '', Math.min(optNum(c.query, 'limit') ?? 30, 100)));
  r.get('/api/products/:id', c => {
    const id = intParam(c.params.id, 'id');
    const product = getProduct(db, id);
    if (!product) throw new ApiError(404, 'Produkt nicht gefunden');
    const s = S();
    const finishes: Record<string, unknown> = {};
    for (const f of ['nonfoil', 'foil'] as Finish[]) {
      const guide = getGuide(db, id, f);
      if (!guide) continue;
      const history = getHistory(db, id, f, 365);
      finishes[f] = { guide, guideMetrics: guideMetrics(guide), history, historyMetrics: historyMetrics(history, s.analysis.volatilityMinDays) };
    }
    return {
      product, finishes, productUrl: `https://www.cardmarket.com/de/Magic/Products?idProduct=${product.externalId}`,
      offers: listOffers(db, { productId: id, includeSimulation: true, limit: 200 }),
      opportunities: queryOpportunities(db, { productId: id, limit: 50 }).items,
      watch: listWatch(db).filter(w => w.productId === id || (w.productId == null && w.nameKey === nameKey(product.name))),
    };
  });

  // ------------------------------------------------------------------ Profit-Rechner
  r.post('/api/calc', c => {
    const b = obj(c.body);
    const num = (k: string, req = false) => {
      const v = b[k];
      if (v == null || v === '') { if (req) throw new ApiError(400, `${k} fehlt`); return null; }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ApiError(400, `${k} muss eine nicht-negative Zahl sein`);
      return v;
    };
    const s = S();
    const buyPrice = num('buyPrice', true) as number;
    let buyShipping = num('buyShipping');
    let shippingNote = 'angegeben';
    if (buyShipping == null) {
      const est = shippingCost(buyPrice, typeof b.sellerCountry === 'string' ? b.sellerCountry : null, s.shipping);
      buyShipping = est.cost;
      shippingNote = 'aus Porto-Einstellungen geschätzt';
    }
    const sellPrice = num('sellPrice');
    const buy = { buyPrice, buyShipping };
    let resale = null;
    if (typeof b.productId === 'number') {
      const g = getGuide(db, b.productId, b.finish === 'foil' ? 'foil' : 'nonfoil');
      if (!g) throw new ApiError(404, 'Für dieses Produkt/Finish liegen keine Preisdaten vor');
      resale = estimateResale(g, s.resale, typeof b.condition === 'string' ? b.condition : null, typeof b.language === 'string' ? b.language : null);
    }
    const scenarios = resale ? computeScenarios(buy, resale, s.fees, s.tax) : null;
    const manual = sellPrice != null ? computeTrade({ ...buy, sellPrice }, s.fees, s.tax) : null;
    const refSell = sellPrice ?? resale?.base ?? null;
    return {
      buyShipping: round2(buyShipping), shippingNote, resale, scenarios, manual,
      breakEvenSellPrice: breakEvenSellPrice(buy, s.fees, s.tax),
      maxBuyPrice: refSell == null ? null : maxBuyPrice(refSell, buyShipping, s.rules.minProfit, s.rules.minRoiPct, s.fees, s.tax),
      maxBuyPriceBasis: refSell == null ? null : (sellPrice != null ? 'manueller Verkaufspreis' : 'Basisszenario'),
      taxMode: s.tax.mode,
    };
  });

  // ------------------------------------------------------------------ Angebote
  r.get('/api/offers', c => listOffers(db, {
    maxAgeHours: optNum(c.query, 'maxAgeHours'), includeSimulation: c.query.get('includeSimulation') === '1', limit: Math.min(optNum(c.query, 'limit') ?? 300, 5000),
  }));

  const afterIngest = async (ids: number[]) => {
    const exposure = buildExposure(db, S());
    const evals = listOffers(db, { ids, includeSimulation: true, limit: ids.length || 1 }).map(o => evaluateOffer(ctx, o, exposure));
    const opps = evals.filter(e => e != null);
    logRecommendations(db, opps);
    await alertsForOffers(ctx, opps);
    scheduler?.scheduleReanalysis();
    return opps;
  };

  r.post('/api/offers', async c => {
    const b = obj(c.body);
    const source = b.source === 'manual' ? 'manual' : b.source === 'extension' ? 'extension' : null;
    if (!source) throw new ApiError(400, "source muss 'extension' oder 'manual' sein");
    if (!Array.isArray(b.offers)) throw new ApiError(400, 'offers: Liste erwartet');
    if (b.offers.length > 500) throw new ApiError(413, 'Höchstens 500 Angebote pro Anfrage');
    const res = ingestOffers(ctx, source, 'LIVE_OFFER', b.offers as OfferInput[]);
    const opps = await afterIngest(res.offerIds);
    const indexOf = new Map(res.items.map(i => [i.offerId, i.index]));
    return {
      ...res,
      evaluations: opps.map(o => ({
        key: o.key, offerId: o.buy.offerId, index: indexOf.get(o.buy.offerId as number) ?? null,
        price: o.buy.price, shipping: o.buy.shipping, effective: o.buy.effective, sellBase: o.resale.base, sellConservative: o.resale.conservative,
        profitBase: o.scenarios.base?.profit ?? null, profitConservative: o.scenarios.conservative?.profit ?? null, roiBase: o.scenarios.base?.roiPct ?? null,
        score: o.score.score, confidence: o.score.confidence, recommendation: o.recommendation, rulesPassed: o.rules.passed, reasons: o.reasons.slice(0, 4),
      })),
    };
  });

  r.post('/api/offers/csv', async c => {
    const b = obj(c.body);
    const text = typeof b.text === 'string' ? b.text : typeof b.csv === 'string' ? b.csv : null;
    if (!text) throw new ApiError(400, 'CSV-Text fehlt (Feld "csv")');
    const parsed = parseOfferCsv(text);
    if (!parsed.offers.length) throw new ApiError(400, 'Keine gültigen Angebote im CSV', parsed.errors);
    const res = ingestOffers(ctx, 'manual', 'LIVE_OFFER', parsed.offers);
    await afterIngest(res.offerIds);
    return { ...res, parseErrors: parsed.errors };
  });

  r.post('/api/simulation', async c => {
    const b = obj(c.body);
    const count = typeof b.count === 'number' ? Math.min(Math.max(1, Math.floor(b.count)), 500) : 40;
    const res = generateSimulation(ctx, count, typeof b.seed === 'number' ? b.seed : Date.now() % 100000);
    await afterIngest(res.offerIds);
    return res;
  });
  r.delete('/api/simulation', () => ({ deleted: clearSimulation(db) }));

  r.get('/api/bundles', c => (c.query.get('mode') === 'deals' ? { mode: 'deals', bundles: dealBundles(ctx) } : { mode: 'watchlist', ...watchlistBundles(ctx, optNum(c.query, 'maxAgeDays') ?? 7) }));

  // ------------------------------------------------------------------ Watchlist
  r.get('/api/watchlist', c => listWatch(db, c.query.get('list') ?? undefined));
  r.get('/api/watchlist/lists', () => db.all('SELECT list_name AS name, COUNT(*) AS entries FROM watchlist GROUP BY list_name ORDER BY list_name'));
  r.post('/api/watchlist', c => {
    const b = obj(c.body) as WatchInput;
    const err = validateWatch(b, false);
    if (err) throw new ApiError(400, err);
    return addWatch(db, b);
  });
  r.patch('/api/watchlist/:id', c => {
    const b = obj(c.body) as WatchInput;
    const err = validateWatch(b, true);
    if (err) throw new ApiError(400, err);
    const e = updateWatch(db, intParam(c.params.id, 'id'), b);
    if (!e) throw new ApiError(404, 'Eintrag nicht gefunden');
    return e;
  });
  r.delete('/api/watchlist/:id', c => { if (!deleteWatch(db, intParam(c.params.id, 'id'))) throw new ApiError(404, 'Eintrag nicht gefunden'); });
  r.post('/api/watchlist/import-legacy', c => {
    const b = obj(c.body);
    if (!Array.isArray(b.entries)) throw new ApiError(400, 'entries: Liste erwartet');
    return importLegacyWatchlist(db, b.entries);
  });

  // ------------------------------------------------------------------ Alarme
  r.get('/api/alerts', c => listAlerts(db, {
    sinceId: optNum(c.query, 'sinceId'), unreadOnly: c.query.get('unread') === '1', limit: Math.min(optNum(c.query, 'limit') ?? 100, 500),
    kind: c.query.get('kind') ?? undefined, signalClass: c.query.get('signalClass') ?? undefined, priority: c.query.get('priority') ?? undefined,
  }));
  r.post('/api/alerts/:id/read', c => { db.run('UPDATE alerts SET read_at = ? WHERE id = ? AND read_at IS NULL', [nowIso(), intParam(c.params.id, 'id')]); });
  r.post('/api/alerts/read-all', () => ({ updated: db.run('UPDATE alerts SET read_at = ? WHERE read_at IS NULL', [nowIso()]).changes }));
  r.post('/api/alerts/test', async () => {
    const res = await dispatchAlerts(ctx, [{
      kind: 'live_offer', signalClass: 'MARKET_SIGNAL', priority: 'HIGH', productId: null, dedupeKey: `test:${Date.now()}`,
      title: 'Testalarm – Kanalprüfung', message: 'Dies ist ein Test der Benachrichtigungskanäle. Keine Handelsinformation.', payload: { source: 'test' },
    }]);
    return { ...res, alert: listAlerts(db, { limit: 1 })[0] };
  });

  // ------------------------------------------------------------------ Entscheidungen → Einkauf
  r.get('/api/decisions', c => listDecisions(db, Math.min(optNum(c.query, 'limit') ?? 200, 1000)));
  r.post('/api/decisions', c => {
    const b = obj(c.body);
    if (b.decision !== 'accepted' && b.decision !== 'rejected') throw new ApiError(400, 'decision: accepted | rejected');
    if (typeof b.opportunityKey !== 'string') throw new ApiError(400, 'opportunityKey fehlt');
    const o = getOpportunity(db, b.opportunityKey);
    if (!o) throw new ApiError(404, 'Möglichkeit nicht in der aktuellen Rangliste – bitte neu laden');
    if (o.signalClass === 'SIMULATION' && b.decision === 'accepted') throw new ApiError(400, 'Simulierte Angebote können nicht gekauft werden');
    return db.tx(() => {
      const id = recordDecision(db, { opportunity: o, decision: b.decision as 'accepted' | 'rejected', reason: typeof b.reason === 'string' ? b.reason : null });
      let purchaseOrderId: number | null = null;
      if (b.decision === 'accepted') {
        // Angenommene Empfehlung → geplanter Einkauf (Kapital reserviert), Status danach im Purchase Manager pflegen.
        const p = (b.purchase && typeof b.purchase === 'object' ? b.purchase : {}) as { qty?: number; unitPrice?: number; shippingCost?: number; status?: 'planned' | 'ordered' | 'paid' };
        purchaseOrderId = createPurchase(db, {
          supplier: o.buy.seller, platform: 'cardmarket', status: p.status ?? 'planned', shippingCost: p.shippingCost ?? o.buy.shipping,
          notes: `Aus Empfehlung ${o.key} (${o.strategyLabel}, Score ${o.score.score})`,
          lines: [{ productId: o.productId, finish: o.finish, condition: o.buy.condition === 'MIX' ? null : o.buy.condition, language: o.buy.language,
            qty: p.qty ?? 1, unitPrice: p.unitPrice ?? o.buy.price, decisionId: id, opportunityKey: o.key }],
        });
        const line = db.get<{ id: number }>('SELECT id FROM purchase_lines WHERE po_id = ?', [purchaseOrderId]);
        db.run('UPDATE decisions SET purchase_line_id = ? WHERE id = ?', [line?.id ?? null, id]);
      }
      return { id, purchaseOrderId };
    });
  });

  // ------------------------------------------------------------------ Gespeicherte Ansichten
  r.get('/api/views', () => db.all<{ id: number; name: string; config: string; created_at: string }>('SELECT * FROM saved_views ORDER BY name')
    .map(v => ({ id: v.id, name: v.name, config: parseJson(v.config, {}), createdAt: v.created_at })));
  r.post('/api/views', c => {
    const b = obj(c.body);
    if (typeof b.name !== 'string' || !b.name.trim()) throw new ApiError(400, 'Name fehlt');
    db.run('INSERT INTO saved_views (name, config, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET config = excluded.config',
      [b.name.trim().slice(0, 80), JSON.stringify(b.config ?? {}), nowIso()]);
    return { ok: true };
  });
  r.delete('/api/views/:id', c => { db.run('DELETE FROM saved_views WHERE id = ?', [intParam(c.params.id, 'id')]); });

  r.get('/api/analysis/latest', () => ({ runId: latestRunId(db) }));
}
