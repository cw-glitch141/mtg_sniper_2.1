/**
 * Analyse-Lauf (Strategie 6 – Opportunity Ranking): wendet alle Strategien auf den aktuellen
 * Datenbestand an, bewertet jede Möglichkeit und speichert eine globale Rangliste.
 */
import { nowIso, parseJson, type Db } from '../db/database.ts';
import { buildOpportunity, type Opportunity } from '../analytics/opportunity.ts';
import { priceDip, spreadLow, volatilityScan } from '../analytics/strategies.ts';
import { guideMetrics, implausible } from '../analytics/stats.ts';
import type { Finish } from '../domain/types.ts';
import { logger } from '../util/log.ts';
import type { AppContext } from './context.ts';
import { evaluateOffer, listOffers } from './offers.ts';
import { getHistoryBulk, toGuide, toProduct, type ProductRow } from './products.ts';
import { buildExposure, snapshotPortfolio } from './portfolio.ts';

/**
 * Jede Kaufempfehlung (KAUFEN/PRÜFEN) einmalig protokollieren – Grundlage der Strategievalidierung.
 * Simulationen werden nie protokolliert.
 */
export function logRecommendations(db: Db, opps: Opportunity[]): void {
  const now = nowIso();
  const st = db.raw.prepare(`INSERT INTO recommendation_log (key, first_seen_at, last_seen_at, product_id, finish, signal_class, strategy, recommendation, priority,
      score, confidence, buy_price, expected_sell, expected_profit, reference_price, discount_pct, rarity, set_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET last_seen_at = excluded.last_seen_at`);
  for (const o of opps) {
    if (o.signalClass === 'SIMULATION' || o.recommendation === 'NICHT KAUFEN') continue;
    st.run(o.key, now, now, o.productId, o.finish, o.signalClass, o.strategy, o.recommendation, o.priority, o.score.score, o.score.confidence,
      o.buy.effective, o.resale.base, o.scenarios.base?.profit ?? null, o.referencePrice, o.discountPct, o.rarity, o.setName);
  }
}

const log = logger('analysis');

export interface AnalysisSummary { runId: number; candidates: number; opportunities: number; dataDate: string | null; durationMs: number; previousRunId: number | null }

interface CandidateRow extends ProductRow {
  finish: Finish; avg: number | null; low: number | null; trend: number | null; avg1: number | null; avg7: number | null; avg30: number | null; source_created_at: string;
}

export function runAnalysis(ctx: AppContext, now = Date.now()): AnalysisSummary {
  const { db } = ctx;
  const s = ctx.settings.get();
  const started = Date.now();
  const prev = db.get<{ id: number }>("SELECT id FROM analysis_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1");
  const runId = db.run("INSERT INTO analysis_runs (started_at, status) VALUES (?, 'running')", [nowIso()]).lastInsertRowid;
  try {
    // Kandidaten: Varianten, deren Referenzpreis (Trend oder 30-Tage-Ø) grob im erlaubten Preisband liegt.
    const lo = s.rules.minPrice * 0.8, hi = s.rules.maxPrice * 1.2;
    const finishes = s.rules.includeFoil ? "('nonfoil','foil')" : "('nonfoil')";
    const rows = db.all<CandidateRow>(`
      SELECT p.id, p.external_id, p.name, p.set_name, p.set_code, p.collector_number, p.rarity, p.image_url, p.mapping_status,
             p.expansion_external_id, p.finishes, l.finish, l.avg, l.low, l.trend, l.avg1, l.avg7, l.avg30, l.source_created_at
      FROM price_latest l JOIN products p ON p.id = l.product_id
      WHERE l.source = 'cardmarket_price_guide' AND l.finish IN ${finishes}
        AND (l.trend BETWEEN ? AND ? OR l.avg30 BETWEEN ? AND ?)`, [lo, hi, lo, hi]);
    const history = getHistoryBulk(db, rows.map(r => ({ productId: r.id, finish: r.finish })));
    const exposure = buildExposure(db, s);

    const market: Opportunity[] = [];
    let dataDate: string | null = null;
    let outliers = 0;
    for (const r of rows) {
      const g = toGuide(r);
      if (!dataDate || g.sourceCreatedAt > dataDate) dataDate = g.sourceCreatedAt;
      // Unplausible Aggregate (dünner Markt, Einzelverkäufe zu Extrempreisen) erzeugen keine Marktsignale.
      if (implausible(guideMetrics(g), s.analysis.maxReferenceRatio)) { outliers++; continue; }
      const series = history.get(`${r.id}:${r.finish}`) ?? [];
      const product = toProduct(r);
      for (const hit of [priceDip(g, series, s), volatilityScan(g, series, s), spreadLow(g, s)]) {
        if (!hit) continue;
        const o = buildOpportunity({
          product, finish: r.finish, guide: g, history: series, strategy: hit.strategy, signalClass: 'MARKET_SIGNAL',
          buy: hit.buy, triggers: hit.triggers, exposure, now,
          confidenceDelta: hit.confidenceDelta, confidenceNote: hit.confidenceNote,
        }, s);
        if ((o.scenarios.base?.profit ?? -1) > 0) market.push(o);
      }
    }
    const order = (a: Opportunity, b: Opportunity) => b.score.score - a.score.score || b.score.confidence - a.score.confidence ||
      (b.scenarios.base?.profit ?? 0) - (a.scenarios.base?.profit ?? 0);
    market.sort(order);
    const kept = market.slice(0, s.analysis.maxOpportunities);

    // Beobachtete Einzelangebote (inkl. Simulation, klar gekennzeichnet). Veraltete bleiben sichtbar, aber markiert.
    const offers = listOffers(db, { maxAgeHours: s.rules.maxOfferAgeHours * 3, includeSimulation: true, limit: 5000 });
    for (const off of offers) {
      const o = evaluateOffer(ctx, off, exposure);
      if (o) kept.push(o);
    }
    kept.sort(order);

    db.tx(() => {
      const st = db.raw.prepare(`INSERT OR REPLACE INTO opportunities (run_id, key, rank, product_id, finish, signal_class, strategy, score, confidence,
          profit_base, roi_base, recommendation, rules_passed, name, set_name, market_price, buy_price, sell_base, discount_pct, risk, priority, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      kept.forEach((o, i) => st.run(runId, o.key, i + 1, o.productId, o.finish, o.signalClass, o.strategy, o.score.score, o.score.confidence,
        o.scenarios.base?.profit ?? null, o.scenarios.base?.roiPct ?? null, o.recommendation, o.rules.passed ? 1 : 0,
        o.name, o.setName, o.marketPrice, o.buy.effective, o.resale.base, o.discountPct, o.score.riskLevel, o.priority, JSON.stringify(o)));
      logRecommendations(db, kept);
      snapshotPortfolio(db, s);
      db.run("UPDATE analysis_runs SET finished_at = ?, status = 'success', candidates = ?, opportunities = ?, data_date = ?, message = ? WHERE id = ?",
        [nowIso(), rows.length, kept.length, dataDate, `${outliers} Varianten mit unplausiblen Aggregaten ausgeschlossen`, runId]);
      // Nur die letzten 7 Läufe behalten (für Ranking-Veränderungen genügt das).
      db.run('DELETE FROM analysis_runs WHERE id NOT IN (SELECT id FROM analysis_runs ORDER BY id DESC LIMIT 7)');
    });
    const summary = { runId, candidates: rows.length, opportunities: kept.length, dataDate, durationMs: Date.now() - started, previousRunId: prev?.id ?? null };
    log.info(`Analyse #${runId}: ${rows.length} Kandidaten, ${kept.length} Möglichkeiten in ${summary.durationMs} ms`);
    return summary;
  } catch (e) {
    db.run("UPDATE analysis_runs SET finished_at = ?, status = 'failed', message = ? WHERE id = ?", [nowIso(), (e as Error).message, runId]);
    log.error('Analyse fehlgeschlagen', e);
    throw e;
  }
}

export function latestRunId(db: Db): number | null {
  return db.get<{ id: number }>("SELECT id FROM analysis_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1")?.id ?? null;
}

export interface OpportunityQuery {
  q?: string; signalClass?: string; strategy?: string; recommendation?: string; finish?: string; risk?: string; priority?: string;
  minScore?: number; minConfidence?: number; minProfit?: number; minRoi?: number; minPrice?: number; maxPrice?: number;
  rulesPassed?: boolean; productId?: number;
  sort?: 'score' | 'profit' | 'roi' | 'confidence' | 'discount' | 'price' | 'name'; dir?: 'asc' | 'desc'; limit?: number; offset?: number;
}

const SORTS: Record<string, string> = {
  score: 'score', profit: 'profit_base', roi: 'roi_base', confidence: 'confidence', discount: 'discount_pct', price: 'market_price', name: 'name',
};

export function queryOpportunities(db: Db, q: OpportunityQuery, runId = latestRunId(db)): { runId: number | null; total: number; items: Opportunity[] } {
  if (runId == null) return { runId: null, total: 0, items: [] };
  const where = ['run_id = ?'];
  const p: (string | number)[] = [runId];
  const add = (cond: string, v: string | number) => { where.push(cond); p.push(v); };
  if (q.q) add('name LIKE ?', `%${q.q}%`);
  if (q.signalClass) add('signal_class = ?', q.signalClass);
  if (q.strategy) add('strategy = ?', q.strategy);
  if (q.recommendation) add('recommendation = ?', q.recommendation);
  if (q.finish) add('finish = ?', q.finish);
  if (q.risk) add('risk = ?', q.risk);
  if (q.priority) add('priority = ?', q.priority);
  if (q.productId != null) add('product_id = ?', q.productId);
  if (q.minScore != null) add('score >= ?', q.minScore);
  if (q.minConfidence != null) add('confidence >= ?', q.minConfidence);
  if (q.minProfit != null) add('profit_base >= ?', q.minProfit);
  if (q.minRoi != null) add('roi_base >= ?', q.minRoi);
  if (q.minPrice != null) add('market_price >= ?', q.minPrice);
  if (q.maxPrice != null) add('market_price <= ?', q.maxPrice);
  if (q.rulesPassed) where.push('rules_passed = 1');
  const w = where.join(' AND ');
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM opportunities WHERE ${w}`, p)?.n ?? 0;
  const sortCol = SORTS[q.sort ?? 'score'] ?? 'score';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const rows = db.all<{ payload: string }>(
    `SELECT payload FROM opportunities WHERE ${w} ORDER BY ${sortCol} IS NULL, ${sortCol} ${dir}, rank ASC LIMIT ? OFFSET ?`,
    [...p, Math.min(q.limit ?? 100, 2000), q.offset ?? 0]);
  return { runId, total, items: rows.map(r => parseJson<Opportunity>(r.payload, null as unknown as Opportunity)).filter(Boolean) };
}

export function getOpportunity(db: Db, key: string): Opportunity | null {
  const runId = latestRunId(db);
  if (runId == null) return null;
  const r = db.get<{ payload: string }>('SELECT payload FROM opportunities WHERE run_id = ? AND key = ?', [runId, key]);
  return r ? parseJson<Opportunity | null>(r.payload, null) : null;
}

/** Preisbewegungen aus den aktuellen Aggregaten bzw. der eigenen Historie (Startbildschirm). */
export function movers(db: Db, opts: { window: 1 | 7 | 30; dir: 'down' | 'up'; minPrice: number; limit: number; maxRatio?: number }) {
  const ratio = opts.maxRatio ?? 3;
  const dirSql = opts.dir === 'down' ? 'ASC' : 'DESC';
  const latestDate = db.get<{ d: string | null }>('SELECT MAX(snapshot_date) AS d FROM price_snapshots')?.d;
  if (latestDate) {
    const pastDate = db.get<{ d: string | null }>(
      'SELECT MAX(snapshot_date) AS d FROM price_snapshots WHERE snapshot_date <= date(?, ?)', [latestDate, `-${opts.window} days`])?.d;
    if (pastDate) {
      const items = db.all(`
        SELECT p.id AS productId, p.name, p.set_name AS setName, p.image_url AS imageUrl, c.finish, o.trend AS fromPrice, c.trend AS toPrice,
               ROUND((c.trend - o.trend) / o.trend * 100, 1) AS changePct, ? AS fromDate, ? AS toDate, 'own_history' AS basis
        FROM price_snapshots c
        JOIN price_snapshots o ON o.product_id = c.product_id AND o.finish = c.finish AND o.source = c.source AND o.snapshot_date = ?
        JOIN products p ON p.id = c.product_id
        WHERE c.snapshot_date = ? AND c.trend >= ? AND o.trend > 0
        ORDER BY changePct ${dirSql} LIMIT ?`, [pastDate, latestDate, pastDate, latestDate, opts.minPrice, opts.limit]);
      return { basis: 'own_history', note: `Eigene Snapshots ${pastDate} → ${latestDate}`, items };
    }
  }
  // Noch keine ausreichende eigene Historie: Cardmarket-Aggregate (1-Tages-Ø ggü. 7-/30-Tages-Ø) – entsprechend gekennzeichnet.
  const ref = opts.window === 30 ? 'avg30' : 'avg7';
  const items = db.all(`
    SELECT p.id AS productId, p.name, p.set_name AS setName, p.image_url AS imageUrl, l.finish, l.${ref} AS fromPrice, l.avg1 AS toPrice,
           ROUND((l.avg1 - l.${ref}) / l.${ref} * 100, 1) AS changePct, NULL AS fromDate, l.source_created_at AS toDate, 'cardmarket_aggregates' AS basis
    FROM price_latest l JOIN products p ON p.id = l.product_id
    WHERE l.trend >= ? AND l.avg1 IS NOT NULL AND l.${ref} > 0
      AND l.avg1 / l.${ref} BETWEEN 1.0 / ? AND ? AND l.trend / l.${ref} BETWEEN 1.0 / ? AND ?
    ORDER BY changePct ${dirSql} LIMIT ?`, [opts.minPrice, ratio, ratio, ratio, ratio, opts.limit]);
  return { basis: 'cardmarket_aggregates', note: `Noch keine eigene ${opts.window}-Tage-Historie: 1-Tages-Ø ggü. ${opts.window === 30 ? '30' : '7'}-Tages-Ø (Cardmarket-Aggregat, Ausreißer > Faktor ${ratio} ausgeblendet)`, items };
}
