/**
 * Alarm-Engine. Jeder Alarm trägt seine Signalklasse:
 *   MARKTSIGNAL  (MARKET_SIGNAL) – aus aggregierten/historischen Preisdaten, kein kaufbares Angebot
 *   LIVE-ANGEBOT (LIVE_OFFER)    – tatsächlich beobachtetes Einzelangebot (mit Beobachtungszeitpunkt)
 *   SIMULATION   (SIMULATION)    – Testdaten; werden nie an externe Kanäle gesendet
 * Deduplizierung: gleicher dedupe_key innerhalb der Cooldown-Zeit → kein neuer Alarm.
 */
import { nowIso, parseJson, type Db } from '../db/database.ts';
import type { Opportunity } from '../analytics/opportunity.ts';
import type { SignalClass } from '../domain/types.ts';
import type { Priority } from '../domain/settings.ts';
import { logger } from '../util/log.ts';
import type { AnalysisSummary } from './analysis.ts';
import { movers, queryOpportunities } from './analysis.ts';
import type { AppContext } from './context.ts';
import { evaluateOffer, listOffers } from './offers.ts';
import { listWatch, nameKey, offerMatchesEntry } from './watchlist.ts';

const log = logger('alerts');

export type AlertKind = 'live_offer' | 'anomaly' | 'watchlist' | 'big_drop' | 'daily_movers' | 'ranking' | 'system';
/** SYSTEM = Betreiber-Meldung (Datenausfall, Feed-Fehler) – nie ein Handelssignal. */
export type AlertClass = SignalClass | 'SYSTEM';
export const SIGNAL_LABEL: Record<AlertClass, string> = { MARKET_SIGNAL: 'MARKTSIGNAL', LIVE_OFFER: 'LIVE-ANGEBOT', SIMULATION: 'SIMULATION', SYSTEM: 'SYSTEM' };

export interface AlertPayload {
  name?: string; setName?: string | null; setCode?: string | null; condition?: string | null; language?: string | null; finish?: string;
  /** Nur bei belegten Angeboten: Einkauf inkl. Porto. Bei Marktsignalen immer leer. */
  buyPrice?: number | null; offerPrice?: number | null; shipping?: number | null; shippingNote?: string | null;
  sellEstimate?: number | null; profit?: number | null; profitConservative?: number | null; roiPct?: number | null; roiConservativePct?: number | null;
  /** Marktsignale: Referenzwerte und ein ausdrücklich hypothetischer Modellwert. */
  referencePrice?: number | null; marketPrice?: number | null; modelValue?: number | null; reportedLow?: number | null;
  seller?: string | null; sellerCountry?: string | null; listingId?: string | null; labels?: string[];
  confidence?: number | null; score?: number | null; dataDate?: string | null; observedAt?: string | null;
  source?: string | null; url?: string | null; productUrl?: string | null; opportunityKey?: string; extra?: unknown;
}

export interface NewAlert { kind: AlertKind; signalClass: AlertClass; priority: Priority | null; dedupeKey: string; productId: number | null; title: string; message: string; payload: AlertPayload }

export const PRIORITY_LABEL: Record<Priority, string> = { HIGH: 'HIGH PRIORITY', MEDIUM: 'MEDIUM PRIORITY', WATCH: 'MARKET WATCH' };
const PRIORITY_RANK: Record<Priority, number> = { HIGH: 0, MEDIUM: 1, WATCH: 2 };

/** Ein Deal = ein Schlüssel, egal über welche Alarmart er gemeldet wird (keine Doppelmeldungen). */
export const dealKey = (o: Opportunity) =>
  o.signalClass === 'MARKET_SIGNAL' ? `market:${o.key}` : `${o.signalClass === 'SIMULATION' ? 'sim' : 'deal'}:${o.buy.offerId}:${o.buy.price}`;

const fmt = (v: number | null | undefined) => (v == null ? '–' : v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const fmtTs = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' }) : '–');

export function payloadFromOpportunity(o: Opportunity): AlertPayload {
  const common = {
    name: o.name, setName: o.setName, setCode: o.setCode, finish: o.finish, labels: o.labels ?? [o.signalClass],
    confidence: o.score.confidence, score: o.score.score, dataDate: o.dataDate, source: o.buy.source,
    productUrl: o.productUrl, opportunityKey: o.key, referencePrice: o.referencePrice, marketPrice: o.marketPrice,
  };
  if (o.signalClass === 'MARKET_SIGNAL') {
    // Kein Einkaufspreis und kein Gewinn: zu diesen Werten ist kein Angebot belegt.
    return { ...common, condition: null, language: null, modelValue: o.buy.price, reportedLow: o.guide?.low ?? null, observedAt: null, url: null };
  }
  return {
    ...common, condition: o.buy.condition, language: o.buy.language,
    buyPrice: o.buy.effective, offerPrice: o.buy.price, shipping: o.buy.shipping, shippingNote: o.buy.shippingNote,
    sellEstimate: o.resale.base, profit: o.scenarios.base?.profit ?? null, roiPct: o.scenarios.base?.roiPct ?? null,
    profitConservative: o.scenarios.conservative?.profit ?? null, roiConservativePct: o.scenarios.conservative?.roiPct ?? null,
    seller: o.buy.seller, sellerCountry: o.buy.sellerCountry, listingId: o.buy.externalId ?? null,
    observedAt: o.buy.observedAt, url: o.buy.offerUrl,
  };
}

/** Einheitlicher Text für alle Kanäle – enthält Signalklasse, Quelle und Zeitstempel. */
export function formatAlertText(a: { signalClass: AlertClass; priority?: Priority | null; title: string; message: string; payload: AlertPayload }): string {
  const p = a.payload;
  const tags = (p.labels?.length ? p.labels : [SIGNAL_LABEL[a.signalClass]]).join(' · ');
  const lines = [`[${a.priority ? PRIORITY_LABEL[a.priority] + ' · ' : ''}${tags}] ${a.title}`];
  if (a.message) lines.push(a.message);
  if (a.signalClass !== 'MARKET_SIGNAL' && p.buyPrice != null) {
    const what = [p.setName ? `${p.setName}${p.setCode ? ' (' + p.setCode.toUpperCase() + ')' : ''}` : null, p.finish === 'foil' ? 'Foil' : null,
      p.condition, p.language?.toUpperCase()].filter(Boolean).join(' · ');
    if (what) lines.push(what);
    lines.push(`Angebot ${fmt(p.offerPrice)} + Porto ${fmt(p.shipping)}${p.shippingNote ? ' (' + p.shippingNote + ')' : ''} = ${fmt(p.buyPrice)}` +
      (p.seller ? ` · Verkäufer ${p.seller}${p.sellerCountry ? ' (' + p.sellerCountry + ')' : ''}` : '') + (p.listingId ? ` · Angebots-ID ${p.listingId}` : ''));
    lines.push(`Gewinn konservativ ${fmt(p.profitConservative)} · Basis ${fmt(p.profit)} (Verkauf ${fmt(p.sellEstimate)}, ROI ${p.roiPct == null ? '–' : p.roiPct + ' %'})`);
  } else if (a.signalClass === 'MARKET_SIGNAL' && (p.marketPrice != null || p.referencePrice != null || p.reportedLow != null)) {
    lines.push(`Referenz: Trend ${fmt(p.marketPrice)} · Median ${fmt(p.referencePrice)}${p.reportedLow != null ? ` · gemeldeter Tiefstpreis ${fmt(p.reportedLow)}` : ''}` +
      (p.modelValue != null ? ` · Modellwert (hypothetisch) ${fmt(p.modelValue)}` : ''));
  }
  const meta: string[] = [];
  if (p.confidence != null) meta.push(`Confidence ${p.confidence}`);
  if (p.dataDate) meta.push(`Price Guide ${fmtTs(p.dataDate)}`);
  if (p.observedAt) meta.push(`beobachtet ${fmtTs(p.observedAt)}`);
  if (p.source) meta.push(`Quelle ${p.source}`);
  if (meta.length) lines.push(meta.join(' · '));
  if (a.signalClass === 'MARKET_SIGNAL') lines.push('Kein konkretes Angebot bekannt – vor dem Kauf auf Cardmarket prüfen.');
  if (a.signalClass === 'SIMULATION') lines.push('Testdaten – keine Kaufmöglichkeit.');
  if (a.signalClass === 'LIVE_OFFER') lines.push('Vor der Zahlung auf der Angebotsseite prüfen: Preis, Zustand, Sprache und Verfügbarkeit können sich geändert haben. Kauf nur manuell.');
  const link = p.url ?? p.productUrl;
  if (link) lines.push(link);
  return lines.join('\n');
}

function inCooldown(db: Db, key: string, hours: number): boolean {
  const since = new Date(Date.now() - hours * 36e5).toISOString();
  return !!db.get('SELECT 1 FROM alerts WHERE dedupe_key = ? AND created_at >= ? LIMIT 1', [key, since]);
}

function oppTitle(o: Opportunity): string {
  return `${o.name}${o.setName ? ' (' + o.setName + ')' : ''}${o.finish === 'foil' ? ' Foil' : ''}` +
    (o.buy.condition && o.buy.condition !== 'MIX' ? ` · ${o.buy.condition}` : '') + (o.buy.language ? `/${o.buy.language.toUpperCase()}` : '');
}

/** Kandidaten für neue Alarme aus Analyse-Ergebnis, Watchlist und Preisbewegungen erzeugen. */
export function collectAlerts(ctx: AppContext, summary: AnalysisSummary | null): NewAlert[] {
  const s = ctx.settings.get();
  const a = s.alerts;
  const out: NewAlert[] = [];
  if (!a.enabled) return out;
  const good = (o: Opportunity) => o.score.score >= a.minScore && o.score.confidence >= a.minConfidence;

  // Watchlist zuerst: trifft ein Angebot sowohl Watchlist-Ziel als auch Kaufregeln, wird es einmal (als Watchlist-Treffer) gemeldet.
  if (a.types.watchlist) {
    const entries = listWatch(ctx.db).filter(e => !e.bought && e.targetPrice != null);
    if (entries.length) {
      const offers = listOffers(ctx.db, { maxAgeHours: s.rules.maxOfferAgeHours, includeSimulation: true, limit: 5000 });
      for (const e of entries) {
        const target = e.targetPrice as number;
        for (const off of offers) {
          const match = e.productId != null ? off.productId === e.productId : nameKey(off.productName ?? '') === e.nameKey;
          if (!match) continue;
          if (e.finish && off.finish !== e.finish) continue;
          if (!offerMatchesEntry(e, off, s.rules.worstCondition, s.rules.allowedLanguages)) continue;
          const o = evaluateOffer(ctx, off);
          const eff = o?.buy.effective ?? off.price;
          if (eff > target) continue;
          out.push({ kind: 'watchlist', signalClass: off.signalClass, priority: off.signalClass === 'SIMULATION' ? null : (o?.priority === 'HIGH' ? 'HIGH' : 'MEDIUM'),
            dedupeKey: o ? dealKey(o) : `${off.signalClass === 'SIMULATION' ? 'sim' : 'deal'}:${off.id}:${off.price}`, productId: off.productId,
            title: `🎯 ${e.name}: ${fmt(eff)} ≤ Zielpreis ${fmt(target)}`,
            message: `${off.condition ?? '?'}/${(off.language ?? '?').toUpperCase()}${off.seller ? ' von ' + off.seller : ''} (inkl. geschätztem Porto).`,
            payload: o ? payloadFromOpportunity(o) : { name: e.name, buyPrice: eff, observedAt: off.observedAt, source: off.source, url: off.url } });
        }
        // Marktsignal: gemeldeter Tiefstpreis unter Ziel (Zustand/Sprache unbekannt).
        const rows = ctx.db.all<{ id: number; external_id: number; name: string; set_name: string | null; finish: string; low: number; source_created_at: string }>(`
          SELECT p.id, p.external_id, p.name, p.set_name, l.finish, l.low, l.source_created_at FROM price_latest l JOIN products p ON p.id = l.product_id
          WHERE l.low IS NOT NULL AND l.low <= ? AND ${e.productId != null ? 'p.id = ?' : 'p.name = ? COLLATE NOCASE'}
            AND (? IS NULL OR l.finish = ?) ORDER BY l.low LIMIT 1`, [target, e.productId ?? e.name, e.finish, e.finish]);
        for (const r of rows) {
          out.push({ kind: 'watchlist', signalClass: 'MARKET_SIGNAL', priority: 'WATCH', productId: r.id, dedupeKey: `watchmarket:${e.id}:${r.source_created_at.slice(0, 10)}`,
            title: `${e.name}: gemeldeter Tiefstpreis ${fmt(r.low)} ≤ Ziel ${fmt(target)}`,
            message: `${r.set_name ?? ''}${r.finish === 'foil' ? ' Foil' : ''} – Zustand/Sprache unbekannt, Angebot evtl. nicht mehr verfügbar.`,
            payload: { name: r.name, setName: r.set_name, finish: r.finish, reportedLow: r.low, labels: ['MARKTSIGNAL'], dataDate: r.source_created_at, source: 'cardmarket_price_guide', productUrl: `https://www.cardmarket.com/de/Magic/Products?idProduct=${r.external_id}` } });
        }
      }
    }
  }

  if (a.types.liveOffers) {
    // HIGH immer; MEDIUM nur ab Mindest-Score/Confidence (berücksichtigt Bestand und Kapital über die Kaufregeln).
    for (const o of queryOpportunities(ctx.db, { signalClass: 'LIVE_OFFER', recommendation: 'KAUFEN', limit: 300 }).items) {
      if (o.priority !== 'HIGH' && !good(o)) continue;
      out.push({ kind: 'live_offer', signalClass: o.signalClass, priority: o.priority, productId: o.productId, dedupeKey: dealKey(o),
        title: oppTitle(o), message: `Kaufempfehlung (Score ${o.score.score}, konservativ ${fmt(o.scenarios.conservative?.profit)}). ${o.buy.label}.`, payload: payloadFromOpportunity(o) });
    }
    // Simulierte Angebote, die die Regeln erfüllen, erscheinen nur im Dashboard (klar als SIMULATION markiert).
    for (const o of queryOpportunities(ctx.db, { signalClass: 'SIMULATION', rulesPassed: true, limit: 50 }).items) {
      out.push({ kind: 'live_offer', signalClass: 'SIMULATION', priority: null, productId: o.productId, dedupeKey: dealKey(o),
        title: oppTitle(o), message: `Simuliertes Angebot erfüllt die Kaufregeln (Score ${o.score.score}).`, payload: payloadFromOpportunity(o) });
    }
  }

  if (a.types.anomalies) {
    for (const strategy of ['price_dip', 'volatility'] as const) {
      // Nur die besten N je Strategie, damit Alarme nicht zum Rauschen werden.
      for (const o of queryOpportunities(ctx.db, { strategy, recommendation: 'PRÜFEN', minScore: a.minScore, minConfidence: a.minConfidence, limit: a.topN }).items) {
        if (!good(o)) continue;
        out.push({ kind: 'anomaly', signalClass: 'MARKET_SIGNAL', priority: o.priority ?? 'MEDIUM', productId: o.productId, dedupeKey: dealKey(o),
          title: oppTitle(o), message: `${o.strategyLabel}: ${o.triggers[0] ?? ''}`, payload: payloadFromOpportunity(o) });
      }
    }
  }

  if (a.types.bigDrops) {
    const m = movers(ctx.db, { window: 1, dir: 'down', minPrice: s.rules.minPrice, maxRatio: s.analysis.maxReferenceRatio, limit: 25 });
    if (m.basis === 'own_history') {
      for (const r of m.items as { productId: number; name: string; setName: string | null; finish: string; fromPrice: number; toPrice: number; changePct: number; toDate: string }[]) {
        if (r.changePct > -s.analysis.bigDropPct) continue;
        out.push({ kind: 'big_drop', signalClass: 'MARKET_SIGNAL', priority: 'WATCH', productId: r.productId, dedupeKey: `drop:${r.productId}:${r.finish}:${r.toDate}`,
          title: `${r.name}${r.setName ? ' (' + r.setName + ')' : ''}${r.finish === 'foil' ? ' Foil' : ''}: Trend ${r.changePct} % an einem Tag`,
          message: `${fmt(r.fromPrice)} → ${fmt(r.toPrice)} (eigene Snapshots).`,
          payload: { name: r.name, setName: r.setName, finish: r.finish, dataDate: r.toDate, source: 'cardmarket_price_guide' } });
      }
    }
  }

  if (a.types.dailyMovers && summary?.dataDate) {
    const down = movers(ctx.db, { window: 1, dir: 'down', minPrice: s.rules.minPrice, maxRatio: s.analysis.maxReferenceRatio, limit: 5 });
    const up = movers(ctx.db, { window: 1, dir: 'up', minPrice: s.rules.minPrice, maxRatio: s.analysis.maxReferenceRatio, limit: 5 });
    const line = (r: { name: string; changePct: number; toPrice: number }) => `${r.name} ${r.changePct > 0 ? '+' : ''}${r.changePct} % (${fmt(r.toPrice)})`;
    const msg = ['Stärkste Rückgänge: ' + (down.items as never[]).map(line).join(', '), 'Stärkste Anstiege: ' + (up.items as never[]).map(line).join(', '), `Basis: ${down.note}`].join('\n');
    out.push({ kind: 'daily_movers', signalClass: 'MARKET_SIGNAL', priority: 'WATCH', productId: null, dedupeKey: `daily:${summary.dataDate.slice(0, 10)}`,
      title: `Tägliche Marktbewegungen ${summary.dataDate.slice(0, 10)}`, message: msg,
      payload: { dataDate: summary.dataDate, source: 'cardmarket_price_guide' } });
  }

  if (a.types.rankingChanges && summary?.previousRunId) {
    const topNow = ctx.db.all<{ key: string; payload: string }>(`SELECT key, payload FROM opportunities WHERE run_id = ? AND rules_passed = 1 AND signal_class != 'SIMULATION' ORDER BY rank LIMIT ?`, [summary.runId, a.topN]);
    const before = new Set(ctx.db.all<{ key: string }>(`SELECT key FROM opportunities WHERE run_id = ? AND rules_passed = 1 ORDER BY rank LIMIT ?`, [summary.previousRunId, a.topN]).map(r => r.key));
    topNow.forEach((r, i) => {
      if (before.has(r.key)) return;
      const o = parseJson<Opportunity | null>(r.payload, null);
      if (!o || !good(o)) return;
      out.push({ kind: 'ranking', signalClass: o.signalClass, priority: o.priority ?? 'WATCH', productId: o.productId, dedupeKey: dealKey(o),
        title: `Neu in den Top ${a.topN} (Platz ${i + 1}): ${oppTitle(o)}`, message: `${o.strategyLabel}, Score ${o.score.score}.`, payload: payloadFromOpportunity(o) });
    });
  }
  return out;
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendDiscord(url: string, text: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
}

export interface Sender { telegram?: (text: string) => Promise<void>; discord?: (text: string) => Promise<void> }

export function defaultSender(ctx: AppContext): Sender {
  const sec = ctx.cfg.secrets;
  return {
    telegram: sec.telegramBotToken && sec.telegramChatId ? t => sendTelegram(sec.telegramBotToken as string, sec.telegramChatId as string, t) : undefined,
    discord: sec.discordWebhookUrl ? t => sendDiscord(sec.discordWebhookUrl as string, t) : undefined,
  };
}

/** Neue Alarme speichern (mit Dedupe/Cooldown) und über die aktivierten Kanäle versenden. */
export async function dispatchAlerts(ctx: AppContext, candidates: NewAlert[], sender = defaultSender(ctx)): Promise<{ created: number; suppressed: number }> {
  const s = ctx.settings.get().alerts;
  let created = 0, suppressed = 0;
  const seen = new Set<string>();
  for (const al of candidates) {
    if (seen.has(al.dedupeKey) || inCooldown(ctx.db, al.dedupeKey, s.cooldownHours)) { suppressed++; continue; }
    seen.add(al.dedupeKey);
    const deliveries: Record<string, string> = { dashboard: 'ok' };
    const text = formatAlertText(al);
    const minRank = PRIORITY_RANK[s.externalMinPriority as Priority] ?? 1;
    const external = al.signalClass !== 'SIMULATION' && al.priority != null && PRIORITY_RANK[al.priority] <= minRank;
    if (!external && al.signalClass !== 'SIMULATION' && (s.channels.telegram || s.channels.discord)) deliveries.extern = `nicht gesendet (Priorität unter ${s.externalMinPriority})`;
    if (external) {
      for (const ch of ['telegram', 'discord'] as const) {
        if (!s.channels[ch]) continue;
        const fn = sender[ch];
        if (!fn) { deliveries[ch] = 'nicht konfiguriert (.env)'; continue; }
        try { await fn(text); deliveries[ch] = 'ok'; } catch (e) { deliveries[ch] = 'Fehler: ' + (e as Error).message; log.warn(`Versand über ${ch} fehlgeschlagen`, e); }
      }
    }
    ctx.db.run(`INSERT INTO alerts (kind, signal_class, priority, dedupe_key, product_id, title, message, payload, created_at, deliveries)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [al.kind, al.signalClass, al.priority, al.dedupeKey, al.productId, al.title, al.message, JSON.stringify(al.payload), nowIso(), JSON.stringify(deliveries)]);
    created++;
  }
  if (created) log.info(`${created} neue Alarme (${suppressed} unterdrückt durch Dedupe/Cooldown)`);
  return { created, suppressed };
}

export function listAlerts(db: Db, opts: { sinceId?: number; unreadOnly?: boolean; limit?: number; kind?: string; signalClass?: string; priority?: string } = {}) {
  const where: string[] = [];
  const p: (string | number)[] = [];
  if (opts.priority) { where.push('priority = ?'); p.push(opts.priority); }
  if (opts.sinceId != null) { where.push('id > ?'); p.push(opts.sinceId); }
  if (opts.unreadOnly) where.push('read_at IS NULL');
  if (opts.kind) { where.push('kind = ?'); p.push(opts.kind); }
  if (opts.signalClass) { where.push('signal_class = ?'); p.push(opts.signalClass); }
  const rows = db.all<Record<string, unknown>>('SELECT * FROM alerts' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?', [...p, opts.limit ?? 100]);
  return rows.map(r => ({
    id: r.id, kind: r.kind, signalClass: r.signal_class, signalLabel: SIGNAL_LABEL[r.signal_class as AlertClass] ?? String(r.signal_class),
    priority: r.priority ?? null, priorityLabel: r.priority ? PRIORITY_LABEL[r.priority as Priority] : null, title: r.title, message: r.message,
    payload: parseJson<AlertPayload>(r.payload, {}), createdAt: r.created_at, readAt: r.read_at, deliveries: parseJson<Record<string, string>>(r.deliveries, {}),
  }));
}
