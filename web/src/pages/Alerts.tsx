import { useState } from 'react';
import { api, type AlertItem } from '../api';
import { useShell } from '../App';
import { dateTime, euro, pct } from '../format';
import { Empty, ErrorNotice, ExtraLabels, PriorityBadge, SignalBadge, useAsync, useToast } from '../ui';

const KIND_LABEL: Record<string, string> = {
  live_offer: 'Live-Angebot', anomaly: 'Preisauffälligkeit', watchlist: 'Watchlist-Ziel', big_drop: 'Großer Preisrückgang', daily_movers: 'Tägliche Bewegungen', ranking: 'Ranking-Änderung', system: 'Betrieb (Ausfall/Datenalter)',
};

export function Alerts() {
  const toast = useToast();
  const { status, refreshStatus, openProduct } = useShell();
  const [kind, setKind] = useState('');
  const [sig, setSig] = useState('');
  const [unread, setUnread] = useState(false);
  const [prio, setPrio] = useState('');
  const { data, error, reload } = useAsync(() => api.get<AlertItem[]>(`/api/alerts?limit=300${kind ? '&kind=' + kind : ''}${sig ? '&signalClass=' + sig : ''}${prio ? '&priority=' + prio : ''}${unread ? '&unread=1' : ''}`), [kind, sig, unread, prio]);
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');

  const markRead = async (id: number) => { await api.post(`/api/alerts/${id}/read`); reload(); refreshStatus(); };
  const readAll = async () => { await api.post('/api/alerts/read-all'); reload(); refreshStatus(); };
  const test = async () => {
    try {
      const r = await api.post<{ alert: AlertItem }>('/api/alerts/test');
      toast('Testalarm: ' + Object.entries(r.alert.deliveries).map(([k, v]) => `${k}: ${v}`).join(', '));
      if (perm === 'granted') new Notification('[Test] MTG Deal Sniper', { body: 'Desktop-Benachrichtigungen funktionieren.' });
      reload();
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      <div className="page-head">
        <h1>Alarme</h1>
        <div className="actions">
          {perm !== 'granted' && perm !== 'unsupported' && <button className="btn" onClick={async () => setPerm(await Notification.requestPermission())}>Desktop-Benachrichtigungen erlauben</button>}
          <button className="btn" onClick={test}>Testalarm senden</button>
          <button className="btn" onClick={readAll}>Alle gelesen</button>
        </div>
      </div>
      <div className="notice info small">
        Kanäle: Dashboard ✓ · Desktop {perm === 'granted' ? '✓ (solange das Dashboard geöffnet ist)' : '– (Erlaubnis fehlt)'} · Telegram {status?.channels.telegram ? '✓ konfiguriert' : '– nicht konfiguriert'} · Discord {status?.channels.discord ? '✓ konfiguriert' : '– nicht konfiguriert'} · E-Mail – noch nicht umgesetzt.
        Externe Kanäle werden in den Einstellungen aktiviert; Zugangsdaten gehören in die Datei <code>.env</code>. Simulationen werden nie extern versendet.
      </div>
      <div className="filters">
        <label className="field">Art<select value={kind} onChange={e => setKind(e.target.value)}><option value="">alle</option>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field">Signaltyp<select value={sig} onChange={e => setSig(e.target.value)}><option value="">alle</option><option value="LIVE_OFFER">Live-Angebot</option><option value="MARKET_SIGNAL">Marktsignal</option><option value="SIMULATION">Simulation</option><option value="SYSTEM">System (Betrieb)</option></select></label>
        <label className="field">Priorität<select value={prio} onChange={e => setPrio(e.target.value)}><option value="">alle</option><option value="HIGH">HIGH PRIORITY</option><option value="MEDIUM">MEDIUM</option><option value="WATCH">MARKET WATCH</option></select></label>
        <label className="check"><input type="checkbox" checked={unread} onChange={e => setUnread(e.target.checked)} /> nur ungelesene</label>
      </div>
      <ErrorNotice error={error} />
      {data && (data.length === 0 ? <Empty>Keine Alarme.</Empty> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {data.map(a => {
            const p = a.payload;
            return (
              <div key={a.id} className="card" style={{ opacity: a.readAt ? 0.65 : 1 }}>
                <div className="row">
                  <PriorityBadge p={a.priority} />
                  <SignalBadge c={a.signalClass} /> <ExtraLabels labels={p.labels} />
                  <span className="small muted">{KIND_LABEL[a.kind] ?? a.kind} · {dateTime(a.createdAt)}</span>
                  <span className="spacer" />
                  {!a.readAt && <button className="btn small" onClick={() => markRead(a.id)}>gelesen</button>}
                </div>
                <div style={{ fontWeight: 600, marginTop: 6 }}>{a.title}</div>
                <div className="small" style={{ whiteSpace: 'pre-line' }}>{a.message}</div>
                {a.signalClass !== 'MARKET_SIGNAL' && p.buyPrice != null && (
                  <div className="small" style={{ marginTop: 6 }}>
                    Angebot {euro(p.offerPrice ?? p.buyPrice)}{p.shipping != null ? ` + Porto ${euro(p.shipping)}` : ''} = {euro(p.buyPrice)}
                    {p.condition ? ` · ${p.condition}` : ''}{p.language ? `/${p.language.toUpperCase()}` : ''}{p.seller ? ` · ${p.seller}` : ''}{p.listingId ? ` · ID ${p.listingId}` : ''}
                    <br />Gewinn konservativ {euro(p.profitConservative)} · Basis {euro(p.profit)} (Verkauf {euro(p.sellEstimate)}, ROI {pct(p.roiPct)}) · Confidence {p.confidence ?? '–'}
                  </div>
                )}
                {a.signalClass === 'MARKET_SIGNAL' && (p.marketPrice != null || p.referencePrice != null || p.reportedLow != null) && (
                  <div className="small" style={{ marginTop: 6 }}>
                    Referenz: Trend {euro(p.marketPrice)} · Median {euro(p.referencePrice)}{p.reportedLow != null ? ` · gemeldeter Tiefstpreis ${euro(p.reportedLow)}` : ''}
                    {p.modelValue != null ? ` · Modellwert (hypothetisch) ${euro(p.modelValue)}` : ''} – kein Angebot, kein Gewinn belegt
                  </div>
                )}
                <div className="small muted" style={{ marginTop: 4 }}>
                  {p.dataDate && <>Price Guide: {dateTime(p.dataDate)} · </>}
                  {p.observedAt && <>beobachtet: {dateTime(p.observedAt)} · </>}
                  {p.source && <>Quelle: {p.source} · </>}
                  Zustellung: {Object.entries(a.deliveries).map(([k, v]) => `${k} ${v}`).join(', ')}
                </div>
                <div className="row" style={{ marginTop: 6 }}>
                  {p.url && <a className="btn small" href={p.url} target="_blank" rel="noopener noreferrer">Angebot ↗</a>}
                  {p.productUrl && <a className="btn small" href={p.productUrl} target="_blank" rel="noopener noreferrer">Cardmarket ↗</a>}
                  {p.opportunityKey && <button className="btn small" onClick={() => openProduct(Number(p.opportunityKey?.split(':')[1]), p.opportunityKey)}>Details</button>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
