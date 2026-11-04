/**
 * Orchestrierung: Import → Analyse → Alarme, plus Hintergrund-Zeitplan.
 * Der Zeitplan prüft regelmäßig per HEAD-Request, ob Cardmarket einen neuen Price Guide
 * veröffentlicht hat, und lädt erst dann (die Datei entsteht einmal täglich).
 */
import type { Opportunity } from '../analytics/opportunity.ts';
import { head } from '../providers/http.ts';
import { logger } from '../util/log.ts';
import { collectAlerts, dealKey, dispatchAlerts, payloadFromOpportunity, type NewAlert } from './alerts.ts';
import { runAnalysis, type AnalysisSummary } from './analysis.ts';
import type { AppContext } from './context.ts';
import { importCatalog, importPriceGuide, importScryfall, lastSuccess, type ImportResult } from './importer.ts';
import { alertOperator } from './qualityReport.ts';

const log = logger('pipeline');

export interface PipelineResult { imports: ImportResult[]; analysis: AnalysisSummary | null; alerts: { created: number; suppressed: number } | null }

const hoursSince = (iso: string | null | undefined) => (iso ? (Date.now() - Date.parse(iso)) / 36e5 : Infinity);

export async function analyzeAndAlert(ctx: AppContext): Promise<{ analysis: AnalysisSummary; alerts: { created: number; suppressed: number } }> {
  const analysis = runAnalysis(ctx);
  const alerts = await dispatchAlerts(ctx, collectAlerts(ctx, analysis));
  return { analysis, alerts };
}

export async function runPipeline(ctx: AppContext, opts: { force?: boolean; scryfall?: boolean } = {}): Promise<PipelineResult> {
  const s = ctx.settings.get();
  const imports: ImportResult[] = [];
  const cat = lastSuccess(ctx.db, 'cardmarket_catalog');
  if (opts.force || hoursSince(cat?.finished_at) >= s.scheduler.minHoursBetweenImports) imports.push(await importCatalog(ctx, opts.force));
  const prices = await importPriceGuide(ctx, opts.force);
  imports.push(prices);

  const sf = lastSuccess(ctx.db, 'scryfall');
  const scryfallDue = opts.scryfall ?? hoursSince(sf?.finished_at) >= s.scheduler.scryfallRefreshDays * 24;
  if (scryfallDue) imports.push(await importScryfall(ctx));

  const changed = imports.some(i => i.status === 'success');
  let analysis: AnalysisSummary | null = null;
  let alerts: PipelineResult['alerts'] = null;
  const hasPrices = !!lastSuccess(ctx.db, 'cardmarket_price_guide');
  if (hasPrices && (changed || opts.force)) {
    const r = await analyzeAndAlert(ctx);
    analysis = r.analysis;
    alerts = r.alerts;
  }
  return { imports, analysis, alerts };
}

/** Alarme direkt nach dem Eingang neuer Angebote (ohne auf den nächsten Analyse-Lauf zu warten). */
export async function alertsForOffers(ctx: AppContext, opps: Opportunity[]): Promise<void> {
  const a = ctx.settings.get().alerts;
  if (!a.enabled || !a.types.liveOffers) return;
  const list: NewAlert[] = [];
  for (const o of opps) {
    const ok = o.signalClass === 'SIMULATION' ? o.rules.passed
      : o.recommendation === 'KAUFEN' && (o.priority === 'HIGH' || (o.score.score >= a.minScore && o.score.confidence >= a.minConfidence));
    if (!ok) continue;
    list.push({
      kind: 'live_offer', signalClass: o.signalClass, priority: o.priority, productId: o.productId,
      dedupeKey: dealKey(o),
      title: `${o.name}${o.setName ? ' (' + o.setName + ')' : ''}${o.buy.condition ? ' · ' + o.buy.condition : ''}`,
      message: `Kaufempfehlung (Score ${o.score.score}). ${o.buy.label}.`, payload: payloadFromOpportunity(o),
    });
  }
  if (list.length) await dispatchAlerts(ctx, list);
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private reanalyzeTimer: NodeJS.Timeout | null = null;
  lastTickAt: string | null = null;
  lastError: string | null = null;
  private readonly ctx: AppContext;
  constructor(ctx: AppContext) { this.ctx = ctx; }

  start(): void {
    const minutes = Math.max(15, this.ctx.settings.get().scheduler.checkIntervalMinutes);
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
    setTimeout(() => void this.tick(), 3000);
    log.info(`Zeitplan aktiv: Prüfung alle ${minutes} Minuten`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.reanalyzeTimer) clearTimeout(this.reanalyzeTimer);
    this.timer = null;
  }

  get running(): boolean { return this.timer != null; }

  /** Nach neuen Angeboten die Rangliste gebündelt neu berechnen (höchstens einmal je 20 s). */
  scheduleReanalysis(): void {
    if (this.reanalyzeTimer) return;
    this.reanalyzeTimer = setTimeout(() => {
      this.reanalyzeTimer = null;
      if (lastSuccess(this.ctx.db, 'cardmarket_price_guide')) {
        analyzeAndAlert(this.ctx).catch(e => log.error('Neuberechnung fehlgeschlagen', e));
      }
    }, 20_000);
  }

  async tick(): Promise<void> {
    if (this.busy || !this.ctx.settings.get().scheduler.enabled) return;
    this.busy = true;
    this.lastTickAt = new Date().toISOString();
    try {
      const s = this.ctx.settings.get();
      const prev = lastSuccess(this.ctx.db, 'cardmarket_price_guide');
      let due = !prev;
      if (prev && hoursSince(prev.source_created_at) >= s.scheduler.minHoursBetweenImports && this.ctx.providers.prices.checkUrl) {
        const m = await head(this.ctx.providers.prices.checkUrl);
        due = !!m.lastModified && m.lastModified !== prev.http_last_modified;
        log.info(due ? `Neuer Price Guide verfügbar (${m.lastModified})` : 'Price Guide unverändert');
      }
      const sf = lastSuccess(this.ctx.db, 'scryfall');
      if (due || hoursSince(sf?.finished_at) >= s.scheduler.scryfallRefreshDays * 24) await runPipeline(this.ctx);
      // Ausfälle und veraltete Daten sofort an den Betreiber melden (US-05), nicht erst im Tagesbericht.
      await alertOperator(this.ctx);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      log.error('Zeitplan-Lauf fehlgeschlagen (die App bleibt bedienbar)', e);
    } finally {
      this.busy = false;
    }
  }
}
