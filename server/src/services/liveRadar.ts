/**
 * Live-Deal-Radar: überwacht eine priorisierte Zielmenge von Kartenvarianten über angebotsgenaue,
 * autorisierte Feeds (providers/listings.ts) und meldet neue bzw. preisreduzierte Angebote.
 *
 * Ehrlichkeitsregeln:
 *   - Ohne bereiten, autorisierten Feed entstehen KEINE automatischen Angebote. Der Status sagt das wörtlich.
 *   - Die erste Abfrage einer Variante ist die Grundlinie: Was dabei gefunden wird, ist nicht "neu" und löst keinen Alarm aus.
 *   - Ein Angebot, das nicht mehr erneut beobachtet wird, gilt nach live.maxListingAgeMinutes als VERALTET –
 *     es wird nicht als "verkauft" oder "weg" geraten (Feeds liefern oft nur die günstigsten N Angebote).
 *   - Latenz wird gemessen, nicht behauptet: mit Quell-Zeitstempel exakt, sonst als Obergrenze (Abfragefenster).
 */
import { nowIso, type Db } from '../db/database.ts';
import type { Opportunity } from '../analytics/opportunity.ts';
import { guideMetrics, implausible } from '../analytics/stats.ts';
import type { AppSettings } from '../domain/settings.ts';
import type { Finish } from '../domain/types.ts';
import { nameKey } from './watchlist.ts';
import { targetKey, type ListingProvider, type ListingRecord, type ListingTarget } from '../providers/listings.ts';
import type { OfferInput } from '../providers/types.ts';
import { logger } from '../util/log.ts';
import { dealKey, dispatchAlerts, payloadFromOpportunity, type NewAlert } from './alerts.ts';
import { logRecommendations } from './analysis.ts';
import type { AppContext } from './context.ts';
import { evaluateOffer, ingestOffers, listOffers } from './offers.ts';
import { buildExposure } from './portfolio.ts';

const log = logger('live');

export const NOT_AVAILABLE = 'Automatische Cardmarket-Angebotsüberwachung nicht verfügbar – keine Live-Datenquelle verbunden';
const TARGET_REFRESH_HOURS = 6;

// ------------------------------------------------------------------ Zielmenge (Schritt 3)

interface CandidateRow {
  id: number; external_id: number; name: string; set_code: string | null; collector_number: string | null; finish: Finish;
  trend: number | null; avg: number | null; low: number | null; avg1: number | null; avg7: number | null; avg30: number | null; source_created_at: string;
  watched: number; held: number;
}

export interface SelectedTarget extends ListingTarget { priority: number; reasons: string[] }

/**
 * Hochwertige, nachfragestarke, bewegliche Varianten aus Price Guide und eigener Watchlist auswählen.
 * Die Regeln sind Annahmen und in settings.live.target einstellbar.
 */
export function rankTargets(db: Db, s: AppSettings): SelectedTarget[] {
  const t = s.live.target;
  const finishes = t.includeFoil ? "('nonfoil','foil')" : "('nonfoil')";
  const rows = db.all<CandidateRow>(`
    SELECT p.id, p.external_id, p.name, p.set_code, p.collector_number, l.finish, l.trend, l.avg, l.low, l.avg1, l.avg7, l.avg30, l.source_created_at,
           0 AS watched,
           EXISTS (SELECT 1 FROM stock_lots sl WHERE sl.product_id = p.id AND sl.qty_on_hand > 0) AS held
    FROM price_latest l JOIN products p ON p.id = l.product_id
    WHERE l.source = 'cardmarket_price_guide' AND l.finish IN ${finishes} AND l.trend BETWEEN ? AND ?`, [t.minPrice, t.maxPrice]);
  const watch = db.all<{ product_id: number | null; name_key: string }>('SELECT product_id, name_key FROM watchlist WHERE bought = 0');
  const watchedIds = new Set(watch.filter(w => w.product_id != null).map(w => w.product_id));
  const watchedNames = new Set(watch.filter(w => w.product_id == null).map(w => w.name_key));
  const out: SelectedTarget[] = [];
  for (const r of rows) {
    r.watched = watchedIds.has(r.id) || watchedNames.has(nameKey(r.name)) ? 1 : 0;
    const g = { avg: r.avg, low: r.low, trend: r.trend, avg1: r.avg1, avg7: r.avg7, avg30: r.avg30, sourceCreatedAt: r.source_created_at };
    if (implausible(guideMetrics(g), t.maxSpreadRatio)) continue;
    if (t.requireRecentSales && (r.avg1 == null || r.avg7 == null)) continue;
    const movePct = r.avg1 != null && r.avg7 ? Math.abs(r.avg1 - r.avg7) / r.avg7 * 100 : 0;
    if (t.minVolatilityPct > 0 && movePct < t.minVolatilityPct) continue;
    const reasons = [`Trend ${(r.trend as number).toFixed(2)} €`];
    let priority = Math.log10(r.trend as number) * 20;
    if (r.avg1 != null) { priority += 20; reasons.push('Verkäufe gestern belegt (1-Tages-Ø)'); }
    if (r.avg7 != null) priority += 10;
    if (movePct > 0) { priority += Math.min(movePct, 30); if (movePct >= 5) reasons.push(`1-Tages-Ø weicht ${movePct.toFixed(0)} % vom 7-Tages-Ø ab`); }
    if (r.watched) { priority += 40; reasons.push('auf der Watchlist'); }
    if (r.held) { priority -= 15; reasons.push('bereits im Bestand'); }
    out.push({ productId: r.id, externalId: r.external_id, finish: r.finish, name: r.name, setCode: r.set_code, collectorNumber: r.collector_number, priority: Math.round(priority * 10) / 10, reasons });
  }
  out.sort((a, b) => b.priority - a.priority);
  return out.slice(0, s.live.maxTargets);
}

/** Zielmenge eines Feeds aktualisieren (höchstens alle 6 h) und speichern. Polling-Zustand bleibt erhalten. */
export function refreshTargets(ctx: AppContext, providerId: string, force = false): number {
  const { db } = ctx;
  const metaKey = `live_targets_selected_at:${providerId}`;
  const last = db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', [metaKey])?.value;
  if (!force && last && Date.now() - Date.parse(last) < TARGET_REFRESH_HOURS * 36e5) {
    return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM listing_targets WHERE provider = ?', [providerId])?.n ?? 0;
  }
  const ranked = rankTargets(db, ctx.settings.get());
  const now = nowIso();
  db.tx(() => {
    db.run('CREATE TEMP TABLE IF NOT EXISTS _keep (product_id INTEGER, finish TEXT)');
    db.run('DELETE FROM _keep');
    for (const t of ranked) {
      db.run(`INSERT INTO listing_targets (provider, product_id, finish, priority, reasons, selected_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, product_id, finish) DO UPDATE SET priority = excluded.priority, reasons = excluded.reasons`,
        [providerId, t.productId, t.finish, t.priority, JSON.stringify(t.reasons), now]);
      db.run('INSERT INTO _keep (product_id, finish) VALUES (?, ?)', [t.productId, t.finish]);
    }
    // Nicht mehr ausgewählte Varianten fallen heraus (bei erneuter Aufnahme beginnt eine neue Grundlinie).
    db.run('DELETE FROM listing_targets WHERE provider = ? AND NOT EXISTS (SELECT 1 FROM _keep k WHERE k.product_id = listing_targets.product_id AND k.finish = listing_targets.finish)', [providerId]);
    db.run(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [metaKey, now]);
  });
  return ranked.length;
}

interface TargetRow { product_id: number; finish: Finish; priority: number; first_polled_at: string | null; last_polled_at: string | null; external_id: number; name: string; set_code: string | null; collector_number: string | null }

function nextBatch(db: Db, providerId: string, limit: number): TargetRow[] {
  // Nie abgefragte zuerst, dann die am längsten nicht abgefragten (Rundlauf), bei Gleichstand nach Priorität.
  return db.all<TargetRow>(`
    SELECT t.product_id, t.finish, t.priority, t.first_polled_at, t.last_polled_at, p.external_id, p.name, p.set_code, p.collector_number
    FROM listing_targets t JOIN products p ON p.id = t.product_id
    WHERE t.provider = ?
    ORDER BY t.last_polled_at IS NOT NULL, t.last_polled_at, t.priority DESC LIMIT ?`, [providerId, limit]);
}

// ------------------------------------------------------------------ Validierung (US-02)

export interface ListingVerdict { status: 'ok' | 'review' | 'reject'; reasons: string[] }

export function validateListing(l: ListingRecord, expectedFinish: Finish | null): ListingVerdict {
  const reject: string[] = [];
  if (l.price == null || !(l.price > 0)) reject.push('Preis fehlt');
  if (!l.currency) reject.push('Währung fehlt');
  else if (l.currency.toUpperCase() !== 'EUR') reject.push(`Währung ${l.currency} (nur EUR)`);
  if (!l.listingId) reject.push('Angebots-ID fehlt');
  if (expectedFinish && l.finish && l.finish !== expectedFinish) reject.push('andere Variante (Finish)');
  if (l.quantity === 0) reject.push('Menge 0');
  if (l.flags.includes('Verkäufer im Urlaub')) reject.push('Verkäufer im Urlaub – nicht kaufbar');
  if (reject.length) return { status: 'reject', reasons: reject };
  const review: string[] = [];
  if (!l.condition) review.push('Zustand unbekannt');
  if (!l.language) review.push('Sprache unbekannt');
  if (!l.seller) review.push('Verkäufer unbekannt');
  if (!l.finish) review.push('Finish nicht bestätigt');
  if (!l.listingUrl) review.push('kein Link');
  review.push(...l.flags);
  return { status: review.length ? 'review' : 'ok', reasons: review };
}

// ------------------------------------------------------------------ Abfrage (Schritt 4)

export interface PollSummary {
  provider: string; runId: number | null; status: 'success' | 'partial' | 'failed' | 'not_ready'; message: string;
  targets: number; covered: number; unsupported: number; requests: number; listings: number;
  accepted: number; review: number; rejected: number; newListings: number; priceDrops: number; alerts: number;
  rateLimited: boolean; durationMs: number; baselineTargets: number;
}

export async function pollProvider(ctx: AppContext, provider: ListingProvider, hooks: { onIngested?: () => void } = {}): Promise<PollSummary> {
  const { db } = ctx;
  const s = ctx.settings.get();
  const started = Date.now();
  const summary: PollSummary = {
    provider: provider.id, runId: null, status: 'not_ready', message: '', targets: 0, covered: 0, unsupported: 0, requests: 0, listings: 0,
    accepted: 0, review: 0, rejected: 0, newListings: 0, priceDrops: 0, alerts: 0, rateLimited: false, durationMs: 0, baselineTargets: 0,
  };
  const ready = provider.readiness();
  if (!ready.configured || !ready.authorized) {
    summary.message = ready.reason ?? 'nicht bereit';
    summary.runId = db.run(`INSERT INTO live_poll_runs (provider, started_at, finished_at, status, duration_ms, message) VALUES (?, ?, ?, 'not_ready', 0, ?)`,
      [provider.id, nowIso(), nowIso(), summary.message]).lastInsertRowid;
    return summary;
  }
  const runId = db.run(`INSERT INTO live_poll_runs (provider, started_at, status) VALUES (?, ?, 'running')`, [provider.id, nowIso()]).lastInsertRowid;
  summary.runId = runId;
  try {
    refreshTargets(ctx, provider.id);
    const batch = nextBatch(db, provider.id, s.live.maxRequestsPerRun);
    summary.targets = batch.length;
    const byKey = new Map(batch.map(b => [targetKey({ productId: b.product_id, finish: b.finish }), b]));
    const targets: ListingTarget[] = batch.map(b => ({ productId: b.product_id, externalId: b.external_id, finish: b.finish, name: b.name, setCode: b.set_code, collectorNumber: b.collector_number }));
    const res = targets.length ? await provider.fetchListings(targets, { budget: s.live.maxRequestsPerRun })
      : { listings: [], covered: [], unsupported: [], requests: 0, rateLimited: false, errors: [] };
    const detectedAt = nowIso();
    summary.requests = res.requests;
    summary.rateLimited = res.rateLimited;
    summary.covered = res.covered.length;
    summary.unsupported = res.unsupported.length;
    summary.listings = res.listings.length;

    // Validieren und ins gemeinsame Angebotsformat überführen
    const inputs: OfferInput[] = [];
    const inputListing: ListingRecord[] = [];
    for (const l of res.listings) {
      const t = l.targetKey ? byKey.get(l.targetKey) : undefined;
      const v = validateListing(l, t?.finish ?? null);
      if (v.status === 'reject') { summary.rejected++; continue; }
      if (v.status === 'review') summary.review++; else summary.accepted++;
      const expires = new Date(Date.parse(l.fetchedAt) + s.live.maxListingAgeMinutes * 60_000).toISOString();
      inputs.push({
        externalId: l.listingId, productExternalId: l.productExternalId, finish: l.finish ?? t?.finish ?? 'nonfoil',
        condition: l.condition, language: l.language, price: l.price as number, amount: l.quantity,
        seller: l.seller, sellerCountry: l.sellerCountry, sellerType: l.sellerType, url: l.listingUrl, observedAt: l.fetchedAt,
        currency: l.currency, shipping: l.shipping, sourceTimestamp: l.sourceTimestamp, fetchedAt: l.fetchedAt, expiresAt: l.expiresAt ?? expires,
        sourceAuthorized: l.sourceAuthorized, reviewStatus: v.status === 'review' ? 'review' : 'ok', reviewReasons: v.reasons,
      });
      inputListing.push(l);
    }
    const ing = inputs.length ? ingestOffers(ctx, provider.id, provider.signalClass, inputs) : null;
    if (ing) summary.rejected += ing.rejected.length;

    // Ereignisse: neue Angebots-ID (nur nach der Grundlinie) oder belegte Preisänderung
    const events: { offerId: number; type: 'new_listing' | 'price_drop' | 'price_increase'; oldPrice: number | null; newPrice: number; latencyMs: number | null; basis: string | null }[] = [];
    for (const c of ing?.changes ?? []) {
      const l = inputListing[c.index];
      const t = l.targetKey ? byKey.get(l.targetKey) : undefined;
      const baseline = !t?.first_polled_at;
      let type: 'new_listing' | 'price_drop' | 'price_increase' | null = null;
      if (c.change === 'new' && !baseline) type = 'new_listing';
      else if (c.change === 'price_drop') type = 'price_drop';
      else if (c.change === 'price_increase') type = 'price_increase';
      if (!type) continue;
      let latencyMs: number | null = null, basis: string | null = null;
      if (l.sourceTimestamp && Number.isFinite(Date.parse(l.sourceTimestamp))) { latencyMs = Date.parse(detectedAt) - Date.parse(l.sourceTimestamp); basis = 'source_timestamp'; }
      else if (t?.last_polled_at) { latencyMs = Date.parse(detectedAt) - Date.parse(t.last_polled_at); basis = 'poll_window_upper_bound'; }
      events.push({ offerId: c.offerId, type, oldPrice: c.oldPrice, newPrice: c.newPrice, latencyMs, basis });
    }
    summary.newListings = events.filter(e => e.type === 'new_listing').length;
    summary.priceDrops = events.filter(e => e.type === 'price_drop').length;

    // Bewerten und alarmieren (nur neue Angebote / Preissenkungen)
    const alertable = events.filter(e => e.type !== 'price_increase');
    const evIds = new Map<number, number>();
    db.tx(() => {
      for (const e of events) {
        const id = db.run(`INSERT INTO offer_events (offer_id, source, signal_class, event_type, old_price, new_price, detected_at, latency_ms, latency_basis, run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [e.offerId, provider.id, provider.signalClass, e.type, e.oldPrice, e.newPrice, detectedAt, e.latencyMs, e.basis, runId]).lastInsertRowid;
        evIds.set(e.offerId, id);
      }
    });
    if (alertable.length) {
      const exposure = buildExposure(db, s);
      const offers = listOffers(db, { ids: alertable.map(e => e.offerId), includeSimulation: true, limit: alertable.length });
      const opps = offers.map(o => evaluateOffer(ctx, o, exposure)).filter((o): o is Opportunity => o != null);
      logRecommendations(db, opps);
      const evType = new Map(alertable.map(e => [e.offerId, e]));
      const a = s.alerts;
      const list: NewAlert[] = [];
      if (a.enabled && a.types.liveOffers) {
        for (const o of opps) {
          const ok = o.signalClass === 'SIMULATION' ? o.rules.passed : o.recommendation === 'KAUFEN';
          if (!ok) continue;
          const ev = evType.get(o.buy.offerId as number);
          const what = ev?.type === 'price_drop' ? `Preis gesenkt ${ev.oldPrice?.toFixed(2)} → ${ev.newPrice.toFixed(2)} €` : 'Neues Angebot';
          list.push({
            kind: 'live_offer', signalClass: o.signalClass, priority: o.priority, productId: o.productId, dedupeKey: dealKey(o),
            title: `${o.signalClass === 'SIMULATION' ? 'TEST · ' : ''}${what}: ${o.name}${o.setName ? ' (' + o.setName + ')' : ''}${o.finish === 'foil' ? ' Foil' : ''}`,
            message: `Kaufchance über ${provider.label} (Score ${o.score.score}, Confidence ${Math.round(o.score.confidence)}).`,
            payload: payloadFromOpportunity(o),
          });
        }
      }
      if (list.length) {
        const r = await dispatchAlerts(ctx, list);
        summary.alerts = r.created;
        for (const al of list) {
          const alertId = db.get<{ id: number }>('SELECT id FROM alerts WHERE dedupe_key = ? ORDER BY id DESC LIMIT 1', [al.dedupeKey])?.id;
          const offerId = Number(al.payload.opportunityKey?.split(':').pop());
          const evId = evIds.get(offerId);
          if (alertId && evId) db.run('UPDATE offer_events SET alert_id = ? WHERE id = ?', [alertId, evId]);
        }
      }
    }

    // Polling-Zustand der Ziele
    const now = nowIso();
    const perTarget = new Map<string, number>();
    for (const l of res.listings) if (l.targetKey) perTarget.set(l.targetKey, (perTarget.get(l.targetKey) ?? 0) + 1);
    db.tx(() => {
      for (const key of res.covered) {
        const t = byKey.get(key);
        if (!t) continue;
        if (!t.first_polled_at) summary.baselineTargets++;
        db.run(`UPDATE listing_targets SET first_polled_at = COALESCE(first_polled_at, ?), last_polled_at = ?, last_ok_at = ?, last_listings = ?, unsupported = NULL
          WHERE provider = ? AND product_id = ? AND finish = ?`, [now, now, now, perTarget.get(key) ?? 0, provider.id, t.product_id, t.finish]);
      }
      for (const u of res.unsupported) {
        const t = byKey.get(u.key);
        if (t) db.run('UPDATE listing_targets SET last_polled_at = ?, unsupported = ? WHERE provider = ? AND product_id = ? AND finish = ?', [now, u.reason, provider.id, t.product_id, t.finish]);
      }
    });

    summary.status = res.errors.length || res.rateLimited ? (res.covered.length ? 'partial' : 'failed') : 'success';
    summary.message = [
      `${res.covered.length}/${batch.length} Varianten abgefragt, ${res.unsupported.length} nicht abgedeckt`,
      summary.baselineTargets ? `${summary.baselineTargets} neue Grundlinien (keine Alarme)` : '',
      ...res.errors.slice(0, 3),
    ].filter(Boolean).join(' · ');
    if (ing && ing.offerIds.length) hooks.onIngested?.();
  } catch (e) {
    summary.status = 'failed';
    summary.message = (e as Error).message;
    log.error(`Live-Abfrage ${provider.id} fehlgeschlagen`, e);
  }
  summary.durationMs = Date.now() - started;
  db.run(`UPDATE live_poll_runs SET finished_at = ?, status = ?, targets = ?, covered = ?, unsupported = ?, requests = ?, listings = ?, accepted = ?, review = ?,
      rejected = ?, new_listings = ?, price_drops = ?, alerts = ?, rate_limited = ?, duration_ms = ?, message = ? WHERE id = ?`,
    [nowIso(), summary.status, summary.targets, summary.covered, summary.unsupported, summary.requests, summary.listings, summary.accepted, summary.review,
      summary.rejected, summary.newListings, summary.priceDrops, summary.alerts, summary.rateLimited ? 1 : 0, summary.durationMs, summary.message, runId]);
  log.info(`Live ${provider.id}: ${summary.status} – ${summary.message}`);
  return summary;
}

// ------------------------------------------------------------------ Status / Health (US-04, US-05)

const pctl = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};

export function liveStatus(ctx: AppContext) {
  const { db } = ctx;
  const s = ctx.settings.get();
  const since24 = new Date(Date.now() - 864e5).toISOString();
  const providers = ctx.providers.listings.map(p => {
    const r = p.readiness();
    const last = db.get<Record<string, unknown>>('SELECT * FROM live_poll_runs WHERE provider = ? ORDER BY id DESC LIMIT 1', [p.id]);
    const ok = db.get<{ finished_at: string }>("SELECT finished_at FROM live_poll_runs WHERE provider = ? AND status IN ('success','partial') ORDER BY id DESC LIMIT 1", [p.id]);
    const agg = db.get<{ runs: number; failed: number; rl: number; req: number }>(`SELECT COUNT(*) AS runs, SUM(status = 'failed') AS failed, SUM(rate_limited) AS rl, SUM(requests) AS req
      FROM live_poll_runs WHERE provider = ? AND started_at >= ? AND status != 'not_ready'`, [p.id, since24]);
    const tg = db.get<{ n: number; polled: number; unsupported: number; withListings: number }>(`SELECT COUNT(*) AS n, SUM(last_ok_at IS NOT NULL) AS polled,
      SUM(unsupported IS NOT NULL) AS unsupported, SUM(COALESCE(last_listings, 0) > 0) AS withListings FROM listing_targets WHERE provider = ?`, [p.id]);
    const lastSuccessAt = ok?.finished_at ?? null;
    const healthy = r.configured && r.authorized && lastSuccessAt != null && Date.now() - Date.parse(lastSuccessAt) <= Math.max(3 * s.live.pollIntervalMinutes, 30) * 60_000;
    return {
      id: p.id, label: p.label, kind: p.kind, signalClass: p.signalClass, limits: p.limits, coverage: p.coverage, readiness: r,
      lastRun: last ?? null, lastSuccessAt, healthy,
      runs24h: agg?.runs ?? 0, failed24h: agg?.failed ?? 0, rateLimited24h: agg?.rl ?? 0, requests24h: agg?.req ?? 0,
      targets: { total: tg?.n ?? 0, polled: tg?.polled ?? 0, unsupported: tg?.unsupported ?? 0, withListings: tg?.withListings ?? 0 },
    };
  });
  const live = providers.filter(p => p.kind === 'licensed_api' && p.signalClass === 'LIVE_OFFER');
  const connected = live.filter(p => p.healthy);
  const configuredOnly = live.filter(p => p.readiness.configured && p.readiness.authorized && !p.healthy);
  const test = providers.filter(p => p.kind === 'test' && p.readiness.authorized);
  let headline: string;
  if (connected.length) headline = `Live-Angebotsüberwachung aktiv über ${connected.map(p => p.label).join(', ')}. Cardmarket-Angebote selbst werden NICHT automatisch überwacht (keine Cardmarket-API-Zulassung).`;
  else if (configuredOnly.length) headline = `${NOT_AVAILABLE}. ${configuredOnly.map(p => p.label).join(', ')} ist konfiguriert, aber ohne aktuellen erfolgreichen Abruf – gilt nicht als angeschlossen.`;
  else headline = NOT_AVAILABLE;
  if (test.length) headline += ' · TEST-Feed aktiv: erzeugt ausschließlich SIMULATION-Daten.';

  const lat = db.all<{ latency_ms: number; latency_basis: string }>(`SELECT latency_ms, latency_basis FROM offer_events WHERE detected_at >= ? AND latency_ms IS NOT NULL AND signal_class = 'LIVE_OFFER'`,
    [new Date(Date.now() - 7 * 864e5).toISOString()]);
  const ev = db.get<{ n: number; drops: number; alerts: number; test: number }>(`SELECT SUM(event_type = 'new_listing' AND signal_class = 'LIVE_OFFER') AS n,
    SUM(event_type = 'price_drop' AND signal_class = 'LIVE_OFFER') AS drops, SUM(alert_id IS NOT NULL AND signal_class = 'LIVE_OFFER') AS alerts,
    SUM(signal_class = 'SIMULATION') AS test FROM offer_events WHERE detected_at >= ?`, [since24]);
  // Fehlalarm-Indikator: Live-Alarme, deren Möglichkeit danach abgelehnt wurde (Grund z. B. "Angebot weg").
  const fp = db.get<{ alerted: number; rejected: number }>(`SELECT COUNT(DISTINCT e.id) AS alerted,
      COUNT(DISTINCT CASE WHEN d.decision = 'rejected' THEN e.id END) AS rejected
    FROM offer_events e JOIN alerts a ON a.id = e.alert_id
    LEFT JOIN decisions d ON d.opportunity_key = json_extract(a.payload, '$.opportunityKey')
    WHERE e.signal_class = 'LIVE_OFFER' AND e.detected_at >= ?`, [new Date(Date.now() - 30 * 864e5).toISOString()]);
  const values = lat.map(l => l.latency_ms);
  return {
    available: connected.length > 0,
    headline, notAvailableMessage: NOT_AVAILABLE,
    monitorsCardmarket: false,
    providers,
    events24h: { newListings: ev?.n ?? 0, priceDrops: ev?.drops ?? 0, alerts: ev?.alerts ?? 0, testEvents: ev?.test ?? 0 },
    latency7d: {
      samples: values.length, medianMs: pctl(values, 0.5), p90Ms: pctl(values, 0.9),
      exactSamples: lat.filter(l => l.latency_basis === 'source_timestamp').length,
      note: 'Ohne Quell-Zeitstempel ist der Wert eine Obergrenze: Zeit seit der vorherigen Abfrage derselben Variante.',
    },
    falseAlarm30d: { alerted: fp?.alerted ?? 0, rejectedAfterAlert: fp?.rejected ?? 0,
      ratePct: fp?.alerted ? Math.round((fp.rejected / fp.alerted) * 1000) / 10 : null },
    settings: { pollIntervalMinutes: s.live.pollIntervalMinutes, maxTargets: s.live.maxTargets, maxListingAgeMinutes: s.live.maxListingAgeMinutes },
  };
}

export function listTargets(db: Db, providerId: string | null, limit = 300) {
  return db.all(`SELECT t.provider, t.product_id AS productId, t.finish, t.priority, t.reasons, t.first_polled_at AS firstPolledAt, t.last_polled_at AS lastPolledAt,
      t.last_ok_at AS lastOkAt, t.last_listings AS lastListings, t.unsupported, p.name, p.set_name AS setName, p.set_code AS setCode
    FROM listing_targets t JOIN products p ON p.id = t.product_id ${providerId ? 'WHERE t.provider = ?' : ''}
    ORDER BY t.priority DESC LIMIT ?`, providerId ? [providerId, limit] : [limit])
    .map(r => ({ ...(r as Record<string, unknown>), reasons: JSON.parse(String((r as { reasons: string | null }).reasons ?? '[]')) }));
}

export function listEvents(db: Db, limit = 100) {
  return db.all(`SELECT e.id, e.event_type AS type, e.signal_class AS signalClass, e.source, e.old_price AS oldPrice, e.new_price AS newPrice, e.detected_at AS detectedAt,
      e.latency_ms AS latencyMs, e.latency_basis AS latencyBasis, e.alert_id AS alertId, o.id AS offerId, o.product_id AS productId, o.product_name AS name,
      o.expansion_name AS setName, o.finish, o.condition, o.language, o.seller, o.seller_country AS sellerCountry, o.url, o.observed_at AS observedAt, o.external_id AS listingId
    FROM offer_events e JOIN offers o ON o.id = e.offer_id ORDER BY e.id DESC LIMIT ?`, [limit]);
}

// ------------------------------------------------------------------ Zeitplan

export class LiveRadar {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly lastRun = new Map<string, number>();
  private readonly ctx: AppContext;
  private readonly onIngested: () => void;
  private readonly afterPoll: () => Promise<unknown>;
  lastError: string | null = null;
  constructor(ctx: AppContext, hooks: { onIngested?: () => void; afterPoll?: () => Promise<unknown> } = {}) {
    this.ctx = ctx;
    this.onIngested = hooks.onIngested ?? (() => {});
    this.afterPoll = hooks.afterPoll ?? (async () => {});
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 60_000);
    setTimeout(() => void this.tick(), 10_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  get running(): boolean { return this.timer != null; }

  async tick(force = false): Promise<PollSummary[]> {
    if (this.busy) return [];
    const s = this.ctx.settings.get();
    if (!s.live.enabled && !force) return [];
    this.busy = true;
    const out: PollSummary[] = [];
    try {
      for (const p of this.ctx.providers.listings) {
        const r = p.readiness();
        if (!r.configured || !r.authorized) continue;
        const due = force || Date.now() - (this.lastRun.get(p.id) ?? 0) >= Math.max(2, s.live.pollIntervalMinutes) * 60_000;
        if (!due) continue;
        this.lastRun.set(p.id, Date.now());
        out.push(await pollProvider(this.ctx, p, { onIngested: this.onIngested }));
      }
      if (out.length) await this.afterPoll();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      log.error('Live-Radar-Lauf fehlgeschlagen', e);
    } finally {
      this.busy = false;
    }
    return out;
  }
}
