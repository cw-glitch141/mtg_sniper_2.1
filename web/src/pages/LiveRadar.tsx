import { useState } from 'react';
import { api, type LiveEvent, type LiveStatus, type LiveTarget, type QualityReportData } from '../api';
import { useShell } from '../App';
import { age, dateTime, euro, int } from '../format';
import { Empty, ErrorNotice, SignalBadge, useAsync, useToast } from '../ui';

const EVENT_LABEL: Record<LiveEvent['type'], string> = { new_listing: 'Neues Angebot', price_drop: 'Preis gesenkt', price_increase: 'Preis erhöht' };
const SEV_LABEL = { critical: 'KRITISCH', warning: 'Warnung', info: 'Info' } as const;

const dur = (ms: number | null) => (ms == null ? '–' : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} Min.`);

export function LiveRadar() {
  const toast = useToast();
  const { openProduct, refreshStatus } = useShell();
  const status = useAsync(() => api.get<LiveStatus>('/api/live/status'), []);
  const events = useAsync(() => api.get<LiveEvent[]>('/api/live/events?limit=100'), []);
  const targets = useAsync(() => api.get<LiveTarget[]>('/api/live/targets?limit=300'), []);
  const report = useAsync(() => api.get<QualityReportData>('/api/quality/latest'), []);
  const [busy, setBusy] = useState(false);
  const reload = () => { status.reload(); events.reload(); targets.reload(); report.reload(); refreshStatus(); };

  const poll = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ results: { provider: string; status: string; message: string; newListings: number; priceDrops: number; alerts: number }[] }>('/api/live/poll', {});
      toast(r.results.map(x => `${x.provider}: ${x.status} – ${x.message}${x.status !== 'not_ready' ? ` (${x.newListings} neu, ${x.priceDrops} gesenkt, ${x.alerts} Alarme)` : ''}`).join(' | '), r.results.some(x => x.status === 'failed'));
    } catch (e) { toast((e as Error).message, true); }
    setBusy(false); reload();
  };
  const newReport = async () => {
    setBusy(true);
    try { await api.post('/api/quality/report', {}); toast('Qualitätsbericht erstellt (ohne Teststatus – vollständig über scripts/daily-quality.ps1).'); } catch (e) { toast((e as Error).message, true); }
    setBusy(false); report.reload();
  };

  const s = status.data;
  return (
    <>
      <div className="page-head">
        <h1>Live-Radar</h1>
        <span className="sub">Automatische Überwachung konkreter Angebote – nur über autorisierte Feeds</span>
        <div className="actions">
          <button className="btn primary" disabled={busy} onClick={poll}>{busy ? 'Läuft …' : 'Jetzt abfragen'}</button>
          <button className="btn" disabled={busy} onClick={newReport}>Qualitätsbericht erstellen</button>
        </div>
      </div>
      <ErrorNotice error={status.error} />
      {s && (
        <div className={`live-banner ${s.available ? 'on' : 'off'}`} role="status">
          <strong>{s.available ? 'Live-Feed verbunden' : 'Kein Live-Feed verbunden'}</strong>
          <div>{s.headline}</div>
          {!s.available && <div className="small muted" style={{ marginTop: 6 }}>Kaufchancen entstehen bis dahin nur aus Angeboten, die du mit der Browser-Erweiterung oder per CSV erfasst. Marktsignale stehen unter „Market Watch“ und sind keine Angebote.</div>}
        </div>
      )}

      {s && (
        <div className="grid cols-3" style={{ marginBottom: 16 }}>
          {s.providers.map(p => (
            <div key={p.id} className="card">
              <div className="card-head"><span className={`dot ${p.healthy ? 'ok' : p.readiness.authorized ? 'fail' : 'stale'}`} /><h2>{p.label}</h2><SignalBadge c={p.signalClass} /></div>
              <dl className="kv">
                <dt>Bereit</dt><dd>{p.readiness.configured && p.readiness.authorized ? 'ja' : `nein – ${p.readiness.reason ?? ''}`}</dd>
                <dt>Angeschlossen</dt><dd>{p.healthy ? `ja, letzter Erfolg ${age(p.lastSuccessAt)}` : p.lastSuccessAt ? `nein – letzter Erfolg ${dateTime(p.lastSuccessAt)}` : 'nein – noch kein erfolgreicher Abruf'}</dd>
                <dt>Letzter Lauf</dt><dd className="small">{p.lastRun ? `${p.lastRun.status} · ${dateTime(p.lastRun.started_at)} · ${p.lastRun.message ?? ''}` : '–'}</dd>
                <dt>24 h</dt><dd className="small">{p.runs24h} Läufe, {p.failed24h} fehlgeschlagen, {p.rateLimited24h}× Rate-Limit, {int(p.requests24h)} Anfragen</dd>
                <dt>Abdeckung</dt><dd className="small">{int(p.targets.total)} Ziele · {int(p.targets.polled)} abgefragt · {int(p.targets.withListings)} mit Angeboten · {int(p.targets.unsupported)} nicht abgedeckt</dd>
                <dt>Rate-Limits</dt><dd className="small">{p.limits}</dd>
              </dl>
              <p className="small muted">{p.coverage}</p>
            </div>
          ))}
        </div>
      )}

      {s && (
        <div className="tiles">
          <div className="card tile"><div className="label">Neue Angebote (24 h)</div><div className="value">{int(s.events24h.newListings)}</div><div className="hint">nur echte Feeds, nach der Grundlinie</div></div>
          <div className="card tile"><div className="label">Preissenkungen (24 h)</div><div className="value">{int(s.events24h.priceDrops)}</div></div>
          <div className="card tile"><div className="label">Live-Alarme (24 h)</div><div className="value">{int(s.events24h.alerts)}</div><div className="hint">TEST-Ereignisse: {int(s.events24h.testEvents)}</div></div>
          <div className="card tile"><div className="label">Verzögerung (7 Tage)</div><div className="value">{dur(s.latency7d.medianMs)}</div><div className="hint">Median, P90 {dur(s.latency7d.p90Ms)} · {s.latency7d.samples} Messwerte ({s.latency7d.exactSamples} exakt)</div></div>
          <div className="card tile"><div className="label">Fehlalarm-Indikator</div><div className="value">{s.falseAlarm30d.ratePct == null ? '–' : `${s.falseAlarm30d.ratePct} %`}</div><div className="hint">{s.falseAlarm30d.rejectedAfterAlert} von {s.falseAlarm30d.alerted} Live-Alarmen danach abgelehnt (30 Tage)</div></div>
        </div>
      )}
      {s && <p className="small muted" style={{ marginTop: -6, marginBottom: 16 }}>{s.latency7d.note} Keine Echtzeit-Behauptung: angezeigt wird nur, was gemessen wurde.</p>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>Ereignisse</h2><span className="small muted">neue Angebots-IDs und belegte Preisänderungen</span></div>
        <ErrorNotice error={events.error} />
        {events.data && (events.data.length ? (
          <div className="table-wrap"><table className="compact">
            <thead><tr><th>Erkannt</th><th>Signal</th><th>Ereignis</th><th>Karte</th><th>Zustand</th><th className="num">Preis</th><th>Verkäufer</th><th>Angebots-ID</th><th className="num">Verzögerung</th><th></th></tr></thead>
            <tbody>{events.data.map(e => (
              <tr key={e.id} className={e.productId ? 'clickable' : ''} onClick={() => e.productId && openProduct(e.productId)}>
                <td>{dateTime(e.detectedAt)}</td>
                <td><SignalBadge c={e.signalClass} />{e.source.startsWith('test:') && <span className="badge SIMULATION">TEST</span>}</td>
                <td>{EVENT_LABEL[e.type]}{e.alertId ? ' · Alarm' : ''}</td>
                <td className="wrap">{e.name}{e.finish === 'foil' ? ' (Foil)' : ''}<div className="small muted">{e.setName}</div></td>
                <td>{e.condition ?? '?'}/{(e.language ?? '?').toUpperCase()}</td>
                <td className="num">{e.oldPrice != null ? <span className="muted small">{euro(e.oldPrice)} → </span> : null}{euro(e.newPrice)}</td>
                <td>{e.seller ?? '–'}{e.sellerCountry ? ` (${e.sellerCountry})` : ''}</td>
                <td className="small">{e.listingId}</td>
                <td className="num small" title={e.latencyBasis === 'source_timestamp' ? 'exakt (Zeitstempel der Quelle)' : 'Obergrenze: Zeit seit der vorherigen Abfrage'}>{dur(e.latencyMs)}{e.latencyBasis === 'poll_window_upper_bound' ? ' (max.)' : ''}</td>
                <td>{e.url && <a className="btn small" href={e.url} target="_blank" rel="noopener noreferrer" onClick={ev => ev.stopPropagation()}>Öffnen ↗</a>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>Noch keine Ereignisse. Die erste Abfrage je Variante ist die Grundlinie und erzeugt bewusst keine „neuen“ Angebote.</Empty>)}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h2>Überwachte Varianten</h2><span className="small muted">Zielmenge aus Price Guide, Watchlist und Bestand</span></div>
          {targets.data && (targets.data.length ? (
            <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}><table className="compact">
              <thead><tr><th>Karte</th><th className="num">Priorität</th><th>Zuletzt</th><th className="num">Angebote</th></tr></thead>
              <tbody>{targets.data.map(x => (
                <tr key={`${x.provider}-${x.productId}-${x.finish}`} className="clickable" onClick={() => openProduct(x.productId)} title={x.reasons.join('\n')}>
                  <td className="wrap">{x.name}{x.finish === 'foil' ? ' (Foil)' : ''}<div className="small muted">{x.setName ?? ''}{x.setCode ? ` (${x.setCode.toUpperCase()})` : ''} · {x.provider}</div></td>
                  <td className="num">{x.priority}</td>
                  <td className="small">{x.unsupported ? <span className="neg">nicht abgedeckt: {x.unsupported}</span> : x.lastOkAt ? age(x.lastOkAt) : 'noch nicht abgefragt'}</td>
                  <td className="num">{x.lastListings ?? '–'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty>Keine Zielmenge – sie entsteht beim ersten Lauf eines bereiten Feeds.</Empty>)}
        </div>
        <div className="card">
          <div className="card-head"><h2>Qualitätsbericht</h2>{report.data && <span className={`small ${report.data.status === 'ok' ? 'pos' : 'neg'}`}>{report.data.status.toUpperCase()} · {dateTime(report.data.createdAt)}</span>}</div>
          <ErrorNotice error={report.error} />
          {report.data && (
            <>
              <ol className="small" style={{ paddingLeft: 18 }}>
                {report.data.findings.map(f => <li key={f.code} style={{ marginBottom: 6 }}><strong className={f.severity === 'critical' ? 'neg' : ''}>{SEV_LABEL[f.severity]} · {f.area}:</strong> {f.text}<div className="muted">Vorschlag: {f.suggestion}</div></li>)}
              </ol>
              <div className="small muted">Tests: {report.data.tests ? `${report.data.tests.passed}/${report.data.tests.total} bestanden, Typprüfung ${report.data.tests.typecheck} (${dateTime(report.data.tests.at)})` : 'nicht übergeben – täglich über scripts/daily-quality.ps1 erzeugen'}</div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
