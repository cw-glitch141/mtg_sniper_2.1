/**
 * Täglicher Qualitätsbericht (US-07) und Betreiber-Warnungen (US-05).
 *
 * "Tägliche Verbesserung" heißt hier: messen, Probleme erkennen und konkrete, priorisierte
 * Vorschläge machen. Der Bericht ändert NIE Code, Einstellungen oder Daten.
 */
import { nowIso, parseJson, type Db } from '../db/database.ts';
import { logger } from '../util/log.ts';
import { dispatchAlerts, type NewAlert } from './alerts.ts';
import type { AppContext } from './context.ts';
import { sourceStatus } from './importer.ts';
import { liveStatus } from './liveRadar.ts';

const log = logger('quality');

export type Severity = 'critical' | 'warning' | 'info';
export interface Finding { code: string; severity: Severity; area: string; text: string; suggestion: string }
export interface TestSummary { total: number; passed: number; failed: number; typecheck: 'ok' | 'failed' | 'skipped'; at: string; extensionTests?: string | null }

export interface QualityReport {
  createdAt: string;
  status: 'ok' | 'warning' | 'critical';
  freshness: { source: string; label: string; dataCreatedAt: string | null; ageHours: number | null; stale: boolean; failing: boolean }[];
  imports: { failed24h: number; failed7d: number; lastFailures: { source: string; at: string; message: string | null }[] };
  live: { available: boolean; headline: string; providers: { id: string; label: string; ready: boolean; healthy: boolean; failed24h: number; rateLimited24h: number; requests24h: number; targets: number; unsupported: number }[];
    events24h: { newListings: number; priceDrops: number; alerts: number; testEvents: number }; latencyMedianMs: number | null; latencyP90Ms: number | null; latencySamples: number;
    listings24h: { accepted: number; review: number; rejected: number } };
  dataGaps: { priceRowsWithoutTrend: number; unmappedProducts: number; products: number; offersInReview: number };
  signals: { runId: number | null; bySignal: Record<string, number>; buy: number; review: number; stale: number };
  alerts24h: Record<string, number>;
  falsePositives: { liveAlerts30d: number; rejectedAfterAlert30d: number; ratePct: number | null; rejectionReasons30d: { reason: string; n: number }[] };
  tests: TestSummary | null;
  trend: { previousAt: string | null; deltas: Record<string, number> } ;
  findings: Finding[];
}

/** Gesundheits-Befunde, die auch ohne Bericht sofort gemeldet werden sollen (US-05). */
export function healthFindings(ctx: AppContext): Finding[] {
  const out: Finding[] = [];
  for (const s of sourceStatus(ctx)) {
    if (s.source === 'scryfall') {
      if (s.failing) out.push({ code: `import_failed:${s.source}`, severity: 'warning', area: 'Import', text: `${s.label}: letzter Import fehlgeschlagen (${s.lastRun?.message ?? ''}).`, suggestion: 'Netzwerk/Quelle prüfen; Zuordnung bleibt mit alten Daten nutzbar.' });
      continue;
    }
    if (s.failing) out.push({ code: `import_failed:${s.source}`, severity: 'critical', area: 'Import', text: `${s.label}: letzter Import fehlgeschlagen (${s.lastRun?.message ?? ''}).`, suggestion: 'Unter „Datenquellen“ erneut importieren; bei wiederholtem Fehler URL/Netzwerk prüfen.' });
    else if (s.stale) out.push({ code: `stale:${s.source}`, severity: 'critical', area: 'Datenfrische', text: s.lastSuccessAt ? `${s.label}: Daten ${Math.round(s.ageHours ?? 0)} h alt.` : `${s.label}: noch nie importiert.`, suggestion: 'Läuft der Server mit aktivem Zeitplan? Import manuell starten und Protokoll prüfen.' });
  }
  const live = liveStatus(ctx);
  for (const p of live.providers) {
    if (p.kind !== 'licensed_api' || !p.readiness.authorized) continue;
    const last = p.lastRun as { status?: string; message?: string | null } | null;
    if (last?.status === 'failed') out.push({ code: `live_failed:${p.id}`, severity: 'critical', area: 'Live-Feed', text: `${p.label}: letzte Abfrage fehlgeschlagen (${last.message ?? ''}).`, suggestion: 'Token und Erreichbarkeit prüfen; bei HTTP 401/403 das eigene Token im Anbieterprofil erneuern.' });
    else if (!p.healthy) out.push({ code: `live_stale:${p.id}`, severity: 'critical', area: 'Live-Feed', text: `${p.label}: kein erfolgreicher Abruf in den letzten ${Math.max(3 * live.settings.pollIntervalMinutes, 30)} Minuten.`, suggestion: 'Server/Zeitplan prüfen; „Jetzt abfragen“ im Live-Radar ausführen.' });
    if (p.rateLimited24h > 0) out.push({ code: `rate_limit:${p.id}`, severity: 'warning', area: 'Live-Feed', text: `${p.label}: ${p.rateLimited24h}× Rate-Limit in 24 h.`, suggestion: 'live.cardtrader.maxRequestsPerSecond oder live.maxRequestsPerRun senken bzw. Abfrageintervall erhöhen.' });
  }
  return out;
}

/** Kritische Befunde als Betreiber-Alarm melden (mit Cooldown über den Dedupe-Schlüssel je Tag). */
export async function alertOperator(ctx: AppContext, findings = healthFindings(ctx)): Promise<number> {
  const s = ctx.settings.get().alerts;
  if (!s.enabled || !s.types.system) return 0;
  const day = nowIso().slice(0, 10);
  const list: NewAlert[] = findings.filter(f => f.severity === 'critical').map(f => ({
    kind: 'system', signalClass: 'SYSTEM', priority: 'HIGH', productId: null, dedupeKey: `system:${f.code}:${day}`,
    title: `Betrieb: ${f.text}`, message: `Vorschlag: ${f.suggestion}`, payload: { labels: ['SYSTEM'], source: f.area },
  }));
  if (!list.length) return 0;
  const r = await dispatchAlerts(ctx, list);
  return r.created;
}

export function buildQualityReport(ctx: AppContext, opts: { tests?: TestSummary | null } = {}): QualityReport {
  const { db } = ctx;
  const since24 = new Date(Date.now() - 864e5).toISOString();
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const findings = healthFindings(ctx);

  const freshness = sourceStatus(ctx).map(s => ({ source: s.source, label: s.label, dataCreatedAt: s.dataCreatedAt, ageHours: s.ageHours, stale: s.stale, failing: s.failing }));
  const failures = db.all<{ source: string; started_at: string; message: string | null }>("SELECT source, started_at, message FROM import_runs WHERE status = 'failed' AND started_at >= ? ORDER BY id DESC", [since7]);
  const imports = {
    failed24h: failures.filter(f => f.started_at >= since24).length, failed7d: failures.length,
    lastFailures: failures.slice(0, 5).map(f => ({ source: f.source, at: f.started_at, message: f.message })),
  };

  const ls = liveStatus(ctx);
  const lst = db.get<{ a: number; r: number; x: number }>("SELECT SUM(accepted) AS a, SUM(review) AS r, SUM(rejected) AS x FROM live_poll_runs WHERE started_at >= ? AND provider NOT LIKE 'test:%'", [since24]);
  const live: QualityReport['live'] = {
    available: ls.available, headline: ls.headline,
    providers: ls.providers.map(p => ({ id: p.id, label: p.label, ready: p.readiness.configured && p.readiness.authorized, healthy: p.healthy, failed24h: p.failed24h, rateLimited24h: p.rateLimited24h, requests24h: p.requests24h, targets: p.targets.total, unsupported: p.targets.unsupported })),
    events24h: ls.events24h, latencyMedianMs: ls.latency7d.medianMs, latencyP90Ms: ls.latency7d.p90Ms, latencySamples: ls.latency7d.samples,
    listings24h: { accepted: lst?.a ?? 0, review: lst?.r ?? 0, rejected: lst?.x ?? 0 },
  };
  if (!ls.available) findings.push({ code: 'no_live_feed', severity: 'info', area: 'Live-Feed', text: ls.headline, suggestion: 'Für automatische Angebote eine autorisierte Quelle anschließen (siehe docs/datenquellen.md). Bis dahin entstehen Kaufchancen nur aus Erweiterung/CSV.' });
  for (const p of ls.providers) {
    if (p.readiness.authorized && p.targets.total && p.targets.unsupported / p.targets.total > 0.3) {
      findings.push({ code: `coverage:${p.id}`, severity: 'warning', area: 'Abdeckung', text: `${p.label}: ${p.targets.unsupported} von ${p.targets.total} Zielvarianten nicht abgedeckt.`, suggestion: 'Zielmenge auf abgedeckte Editionen einschränken oder Zuordnung (Set-Codes) prüfen.' });
    }
  }
  if ((lst?.r ?? 0) + (lst?.x ?? 0) > (lst?.a ?? 0) && (lst?.a ?? 0) + (lst?.r ?? 0) + (lst?.x ?? 0) > 20) {
    findings.push({ code: 'listing_quality', severity: 'warning', area: 'Datenqualität', text: 'Mehr Feed-Angebote in Prüfung/abgelehnt als vollständig.', suggestion: 'Ablehnungsgründe im Live-Radar ansehen; Zustands-/Sprachabbildung des Adapters prüfen.' });
  }

  const gaps = db.get<{ noTrend: number; unmapped: number; products: number; review: number }>(`SELECT
      (SELECT COUNT(*) FROM price_latest WHERE trend IS NULL) AS noTrend,
      (SELECT COUNT(*) FROM products WHERE mapping_status != 'mapped') AS unmapped,
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM offers WHERE review_status = 'review' AND observed_at >= ?) AS review`, [since24]);
  const dataGaps = { priceRowsWithoutTrend: gaps?.noTrend ?? 0, unmappedProducts: gaps?.unmapped ?? 0, products: gaps?.products ?? 0, offersInReview: gaps?.review ?? 0 };
  if (dataGaps.products && dataGaps.unmappedProducts / dataGaps.products > 0.2) {
    findings.push({ code: 'mapping', severity: 'warning', area: 'Datenqualität', text: `${dataGaps.unmappedProducts} von ${dataGaps.products} Produkten ohne Scryfall-Zuordnung.`, suggestion: 'Scryfall-Import erneut ausführen; ohne Set-Code ist keine Feed-Zuordnung möglich.' });
  }

  const runId = db.get<{ id: number }>("SELECT id FROM analysis_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1")?.id ?? null;
  const bySignal: Record<string, number> = {};
  let buy = 0, review = 0, stale = 0;
  if (runId != null) {
    for (const r of db.all<{ signal_class: string; n: number }>('SELECT signal_class, COUNT(*) AS n FROM opportunities WHERE run_id = ? GROUP BY signal_class', [runId])) bySignal[r.signal_class] = r.n;
    buy = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM opportunities WHERE run_id = ? AND recommendation = 'KAUFEN'", [runId])?.n ?? 0;
    review = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM opportunities WHERE run_id = ? AND recommendation = 'PRÜFEN'", [runId])?.n ?? 0;
    stale = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM opportunities WHERE run_id = ? AND json_extract(payload, '$.stale') = 1", [runId])?.n ?? 0;
  }
  const alerts24h: Record<string, number> = {};
  for (const r of db.all<{ signal_class: string; n: number }>('SELECT signal_class, COUNT(*) AS n FROM alerts WHERE created_at >= ? GROUP BY signal_class', [since24])) alerts24h[r.signal_class] = r.n;

  const reasons = db.all<{ reason: string; n: number }>(`SELECT COALESCE(NULLIF(TRIM(reason), ''), '(ohne Grund)') AS reason, COUNT(*) AS n FROM decisions
    WHERE decision = 'rejected' AND created_at >= ? GROUP BY 1 ORDER BY n DESC LIMIT 5`, [since30]);
  const falsePositives = { liveAlerts30d: ls.falseAlarm30d.alerted, rejectedAfterAlert30d: ls.falseAlarm30d.rejectedAfterAlert, ratePct: ls.falseAlarm30d.ratePct, rejectionReasons30d: reasons };
  if (falsePositives.liveAlerts30d >= 5 && (falsePositives.ratePct ?? 0) > 50) {
    findings.push({ code: 'false_positive', severity: 'warning', area: 'Signalqualität', text: `${falsePositives.ratePct} % der Live-Alarme wurden danach abgelehnt.`, suggestion: 'Häufigste Ablehnungsgründe prüfen; live.minConservativeProfit, Zustandsfaktoren oder Abschläge anpassen.' });
  }

  const tests = opts.tests ?? null;
  if (tests && (tests.failed > 0 || tests.typecheck === 'failed')) {
    findings.push({ code: 'tests_failed', severity: 'critical', area: 'Tests', text: `${tests.failed} Test(s) fehlgeschlagen, Typprüfung: ${tests.typecheck}.`, suggestion: 'Nicht mergen/deployen; fehlschlagende Tests zuerst beheben (US-06).' });
  } else if (!tests) {
    findings.push({ code: 'tests_unknown', severity: 'info', area: 'Tests', text: 'Teststatus nicht übergeben.', suggestion: 'Bericht über scripts/daily-quality.ps1 erzeugen, das Tests und Typprüfung vorher ausführt.' });
  }

  const prev = db.get<{ created_at: string; summary: string }>('SELECT created_at, summary FROM quality_reports ORDER BY id DESC LIMIT 1');
  const current = { buy, review, newListings: live.events24h.newListings, importFailures24h: imports.failed24h, alerts24h: Object.values(alerts24h).reduce((a, b) => a + b, 0) };
  const deltas: Record<string, number> = {};
  if (prev) {
    const p = parseJson<Record<string, number>>(prev.summary, {});
    for (const [k, v] of Object.entries(current)) if (typeof p[k] === 'number') deltas[k] = v - p[k];
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const status = findings.some(f => f.severity === 'critical') ? 'critical' : findings.some(f => f.severity === 'warning') ? 'warning' : 'ok';
  return {
    createdAt: nowIso(), status, freshness, imports, live, dataGaps,
    signals: { runId, bySignal, buy, review, stale }, alerts24h, falsePositives, tests,
    trend: { previousAt: prev?.created_at ?? null, deltas }, findings,
  };
}

export function saveQualityReport(db: Db, rep: QualityReport): QualityReport & { id: number } {
  const summary = { buy: rep.signals.buy, review: rep.signals.review, newListings: rep.live.events24h.newListings, importFailures24h: rep.imports.failed24h,
    alerts24h: Object.values(rep.alerts24h).reduce((a, b) => a + b, 0) };
  const id = db.run('INSERT INTO quality_reports (created_at, status, summary, report) VALUES (?, ?, ?, ?)', [rep.createdAt, rep.status, JSON.stringify(summary), JSON.stringify(rep)]).lastInsertRowid;
  db.run('DELETE FROM quality_reports WHERE id NOT IN (SELECT id FROM quality_reports ORDER BY id DESC LIMIT 400)');
  log.info(`Qualitätsbericht #${id}: ${rep.status}, ${rep.findings.length} Befunde`);
  return { ...rep, id };
}

export function latestQualityReport(db: Db): (QualityReport & { id: number }) | null {
  const r = db.get<{ id: number; report: string }>('SELECT id, report FROM quality_reports ORDER BY id DESC LIMIT 1');
  return r ? { ...parseJson<QualityReport>(r.report, null as unknown as QualityReport), id: r.id } : null;
}

const SEV: Record<Severity, string> = { critical: '🔴 KRITISCH', warning: '🟠 Warnung', info: '🔵 Info' };
const h = (n: number | null | undefined) => (n == null ? '–' : String(n));
const ms = (v: number | null) => (v == null ? '–' : v < 120_000 ? `${Math.round(v / 1000)} s` : `${Math.round(v / 60_000)} Min.`);

export function renderQualityMarkdown(r: QualityReport): string {
  const L: string[] = [];
  L.push(`# Qualitätsbericht ${r.createdAt.slice(0, 10)}`, '', `Status: **${r.status.toUpperCase()}** · erstellt ${r.createdAt}`, '');
  L.push('## Befunde und Vorschläge (priorisiert)', '');
  if (!r.findings.length) L.push('Keine Befunde.');
  r.findings.forEach((f, i) => L.push(`${i + 1}. ${SEV[f.severity]} · ${f.area}: ${f.text}  `, `   Vorschlag: ${f.suggestion}`));
  L.push('', '## Datenfrische', '', '| Quelle | Datenstand | Alter (h) | Status |', '|---|---|---|---|');
  for (const f of r.freshness) L.push(`| ${f.label} | ${f.dataCreatedAt ?? '–'} | ${h(f.ageHours)} | ${f.failing ? 'Import fehlgeschlagen' : f.stale ? 'veraltet' : 'ok'} |`);
  L.push('', `Import-Fehler: ${r.imports.failed24h} in 24 h, ${r.imports.failed7d} in 7 Tagen.`, '');
  L.push('## Live-Feeds', '', r.live.headline, '', '| Feed | bereit | gesund | Fehler 24h | Rate-Limit 24h | Anfragen 24h | Ziele | nicht abgedeckt |', '|---|---|---|---|---|---|---|---|');
  for (const p of r.live.providers) L.push(`| ${p.label} | ${p.ready ? 'ja' : 'nein'} | ${p.healthy ? 'ja' : 'nein'} | ${p.failed24h} | ${p.rateLimited24h} | ${p.requests24h} | ${p.targets} | ${p.unsupported} |`);
  L.push('', `Ereignisse 24 h (nur echte Feeds): ${r.live.events24h.newListings} neue Angebote, ${r.live.events24h.priceDrops} Preissenkungen, ${r.live.events24h.alerts} Alarme; TEST-Ereignisse: ${r.live.events24h.testEvents}.`);
  L.push(`Gemessene Verzögerung (7 Tage, ${r.live.latencySamples} Werte): Median ${ms(r.live.latencyMedianMs)}, P90 ${ms(r.live.latencyP90Ms)} – ohne Quell-Zeitstempel eine Obergrenze.`);
  L.push(`Feed-Angebote 24 h: ${r.live.listings24h.accepted} vollständig, ${r.live.listings24h.review} zur Prüfung, ${r.live.listings24h.rejected} abgelehnt.`, '');
  L.push('## Datenlücken', '', `Preisreihen ohne Trend: ${r.dataGaps.priceRowsWithoutTrend} · Produkte ohne Scryfall-Zuordnung: ${r.dataGaps.unmappedProducts}/${r.dataGaps.products} · Angebote in Prüfung (24 h): ${r.dataGaps.offersInReview}`, '');
  L.push('## Signale', '', `Letzte Analyse #${h(r.signals.runId)}: ${Object.entries(r.signals.bySignal).map(([k, v]) => `${k} ${v}`).join(', ') || '–'} · KAUFEN ${r.signals.buy} · PRÜFEN ${r.signals.review} · veraltet ${r.signals.stale}`);
  L.push(`Alarme 24 h: ${Object.entries(r.alerts24h).map(([k, v]) => `${k} ${v}`).join(', ') || 'keine'}`, '');
  L.push('## Fehlalarm-Indikatoren (30 Tage)', '', `Live-Alarme: ${r.falsePositives.liveAlerts30d}, danach abgelehnt: ${r.falsePositives.rejectedAfterAlert30d} (${r.falsePositives.ratePct ?? '–'} %).`);
  for (const x of r.falsePositives.rejectionReasons30d) L.push(`- ${x.reason}: ${x.n}`);
  L.push('', '## Tests', '', r.tests ? `${r.tests.passed}/${r.tests.total} bestanden, ${r.tests.failed} fehlgeschlagen · Typprüfung ${r.tests.typecheck}${r.tests.extensionTests ? ' · Extension: ' + r.tests.extensionTests : ''} (${r.tests.at})` : 'nicht übergeben');
  L.push('', '## Trend ggü. vorherigem Bericht', '', r.trend.previousAt ? `Vorheriger Bericht: ${r.trend.previousAt} · ` + (Object.entries(r.trend.deltas).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}`).join(', ') || 'keine Veränderung') : 'erster Bericht');
  L.push('');
  return L.join('\n');
}
