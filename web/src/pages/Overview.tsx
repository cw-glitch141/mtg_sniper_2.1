import { api, type AlertItem, type Movers, type OppList, type OrderList, type Portfolio, type WatchEntry } from '../api';
import { useShell } from '../App';
import { OppTable } from '../components/OppTable';
import { age, dateTime, euro, int, pct } from '../format';
import { Empty, ErrorNotice, SignalBadge, useAsync } from '../ui';

function MoversCard({ dir }: { dir: 'down' | 'up' }) {
  const { openProduct } = useShell();
  const { data, error } = useAsync(() => api.get<Movers>(`/api/movers?window=1&dir=${dir}&limit=8`), [dir]);
  return (
    <div className="card">
      <div className="card-head"><h2>{dir === 'down' ? 'Stärkste Preisrückgänge' : 'Stärkste Preisanstiege'}</h2></div>
      <ErrorNotice error={error} />
      {data && <div className="small muted" style={{ marginBottom: 6 }}>{data.note}</div>}
      {data && (data.items.length ? (
        <table className="compact"><tbody>
          {data.items.map(m => (
            <tr key={`${m.productId}-${m.finish}`} className="clickable" onClick={() => openProduct(m.productId)}>
              <td className="wrap">{m.name}{m.finish === 'foil' ? ' (Foil)' : ''}<div className="small muted">{m.setName}</div></td>
              <td className="num small">{euro(m.fromPrice)} → {euro(m.toPrice)}</td>
              <td className={`num ${m.changePct < 0 ? 'neg' : 'pos'}`}>{pct(m.changePct, true)}</td>
            </tr>
          ))}
        </tbody></table>
      ) : <Empty>Keine Daten.</Empty>)}
    </div>
  );
}

export function Overview() {
  const { status, openProduct, navigate } = useShell();
  const best = useAsync(() => api.get<OppList>('/api/opportunities?signalClass=LIVE_OFFER&rulesPassed=1&limit=8'), []);
  const live = useAsync(() => api.get<OppList>('/api/opportunities?signalClass=LIVE_OFFER&limit=6&sort=profit'), []);
  const profit = useAsync(() => api.get<OppList>('/api/opportunities?signalClass=LIVE_OFFER&rulesPassed=1&sort=profit&limit=6'), []);
  const roi = useAsync(() => api.get<OppList>('/api/opportunities?signalClass=LIVE_OFFER&rulesPassed=1&sort=roi&limit=6'), []);
  const alerts = useAsync(() => api.get<AlertItem[]>('/api/alerts?limit=8'), []);
  const watch = useAsync(() => api.get<WatchEntry[]>('/api/watchlist'), []);
  const portfolio = useAsync(() => api.get<Portfolio>('/api/portfolio'), []);
  const orders = useAsync(() => api.get<OrderList>('/api/orders?active=1&limit=1'), []);
  const counts = useAsync(() => Promise.all([
    api.get<OppList>('/api/opportunities?recommendation=KAUFEN&limit=1'),
    api.get<OppList>('/api/opportunities?signalClass=MARKET_SIGNAL&limit=1'),
  ]), []);

  const open = (o: { productId: number; key: string }) => openProduct(o.productId, o.key);
  const failing = status?.sources.filter(s => s.failing || (s.stale && s.source !== 'scryfall')) ?? [];

  return (
    <>
      <div className="page-head">
        <h1>Übersicht</h1>
        <span className="sub">{status?.analysis?.finished_at ? `Letzte Analyse ${age(status.analysis.finished_at)} · Datenstand ${dateTime(status.analysis.data_date)}` : 'Noch keine Analyse'}</span>
      </div>

      {failing.length > 0 && (
        <div className="notice error">
          <strong>Datenquellen prüfen:</strong>
          <ul>{failing.map(s => <li key={s.source}>{s.label}: {s.failing ? `letzter Import fehlgeschlagen (${s.lastRun?.message ?? ''})` : s.lastSuccessAt ? `Daten ${Math.round(s.ageHours ?? 0)} h alt` : 'noch nie importiert'}</li>)}</ul>
          <button className="btn small" style={{ marginTop: 6 }} onClick={() => navigate('data')}>Zu den Datenquellen</button>
        </div>
      )}
      {status && status.warnings.length > 0 && (
        <div className="notice warn"><strong>Hinweise zur Datenlage</strong><ul>{status.warnings.filter(w => !failing.some(f => w.startsWith(f.label)) && w !== status.live?.headline).map(w => <li key={w}>{w}</li>)}</ul></div>
      )}

      {status?.live && (
        <div className={`live-banner ${status.live.available ? 'on' : 'off'}`} role="status">
          <strong>Live-Radar:</strong> {status.live.headline} <a href="#/live">Details →</a>
        </div>
      )}

      <div className="tiles">
        <div className="card tile"><div className="label">Kaufempfehlungen</div><div className="value">{int(counts.data?.[0].total)}</div><div className="hint">nur Live-Angebote, alle Regeln erfüllt</div></div>
        <div className="card tile clickable" onClick={() => navigate('market')}><div className="label">Marktsignale (Recherche)</div><div className="value">{int(counts.data?.[1].total)}</div><div className="hint">kein Angebot – erst Angebot suchen</div></div>
        <div className="card tile"><div className="label">Live-Angebote</div><div className="value">{int(status?.counts.liveOffers)}</div><div className="hint">{status?.live?.available ? 'Extension, CSV und Live-Feed' : 'aus Extension / CSV – kein Live-Feed'}</div></div>
        <div className="card tile"><div className="label">Ungelesene Alarme</div><div className="value">{int(status?.counts.unreadAlerts)}</div></div>
        <div className="card tile clickable" onClick={() => navigate('capital')}><div className="label">Verfügbares Kapital</div><div className="value">{portfolio.data?.overview.capitalTracked ? euro(portfolio.data.overview.availableCapital) : '–'}</div><div className="hint">{portfolio.data?.overview.capitalTracked ? `im Lager ${euro(portfolio.data.overview.investedInStock)}` : 'Einlage unter Capital & Risk buchen'}</div></div>
        <div className="card tile clickable" onClick={() => navigate('orders')}><div className="label">Offene Aufträge</div><div className="value">{int(orders.data?.total)}</div><div className="hint">Realisierter DB {euro(portfolio.data?.overview.realizedContribution)}</div></div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>Beste aktuelle Angebote</h2><span className="small muted">belegte Einzelangebote, alle Kaufregeln erfüllt</span><a className="more" href="#/scanner?rulesPassed=1">Alle im Scanner →</a></div>
        <ErrorNotice error={best.error} />
        {best.data && (best.data.items.length ? <OppTable items={best.data.items} onOpen={open} compact /> :
          <Empty>Aktuell erfüllt keine Möglichkeit alle Kaufregeln. Das ist bei wenig Historie und ohne Live-Angebote normal – siehe Hinweise oben.</Empty>)}
      </div>

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head"><h2>Höchste Nettoerträge</h2><span className="small muted">nur Angebote</span></div>
          {profit.data?.items.length ? <table className="compact"><tbody>{profit.data.items.map(o => (
            <tr key={o.key} className="clickable" onClick={() => open(o)}><td className="wrap">{o.name}<div className="small muted">{o.setName}</div></td><td className="num pos">{euro(o.scenarios.base?.profit)}</td></tr>
          ))}</tbody></table> : <Empty>–</Empty>}
        </div>
        <div className="card">
          <div className="card-head"><h2>ROI-Rangliste</h2><span className="small muted">nur Angebote</span></div>
          {roi.data?.items.length ? <table className="compact"><tbody>{roi.data.items.map(o => (
            <tr key={o.key} className="clickable" onClick={() => open(o)}><td className="wrap">{o.name}<div className="small muted">{euro(o.buy.effective)} Einsatz</div></td><td className="num">{pct(o.scenarios.base?.roiPct)}</td></tr>
          ))}</tbody></table> : <Empty>–</Empty>}
        </div>
        <div className="card">
          <div className="card-head"><h2>Neueste Live-Angebote</h2><a className="more" href="#/offers">Angebote →</a></div>
          {live.data?.items.length ? <table className="compact"><tbody>{live.data.items.map(o => (
            <tr key={o.key} className="clickable" onClick={() => open(o)}><td className="wrap">{o.name}<div className="small muted">{o.buy.seller} · {age(o.buy.observedAt)}</div></td><td className="num">{euro(o.buy.effective)}</td><td className="num"><span className={(o.scenarios.base?.profit ?? 0) > 0 ? 'pos' : 'neg'}>{euro(o.scenarios.base?.profit)}</span></td></tr>
          ))}</tbody></table> : <Empty>Noch keine beobachteten Angebote. Browser-Erweiterung aktivieren oder CSV importieren.</Empty>}
        </div>
      </div>

      <div className="grid cols-3">
        <MoversCard dir="down" />
        <MoversCard dir="up" />
        <div className="card">
          <div className="card-head"><h2>Neue Signale</h2><a className="more" href="#/alerts">Alle Alarme →</a></div>
          {alerts.data?.length ? <div style={{ display: 'grid', gap: 8 }}>{alerts.data.map(a => (
            <div key={a.id} className="small" style={{ opacity: a.readAt ? 0.6 : 1 }}>
              <SignalBadge c={a.signalClass} /> <span className="muted">{age(a.createdAt)}</span>
              <div>{a.title}</div>
            </div>
          ))}</div> : <Empty>Keine Alarme.</Empty>}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>Beobachtete Produkte</h2><a className="more" href="#/watchlist">Watchlist →</a></div>
        {watch.data?.filter(w => !w.bought).length ? (
          <div className="row">{watch.data.filter(w => !w.bought).slice(0, 30).map(w => (
            <span key={w.id} className="badge MARKET_SIGNAL" style={{ cursor: w.productId ? 'pointer' : 'default' }} onClick={() => w.productId && openProduct(w.productId)}>
              {w.qty}× {w.name}{w.targetPrice ? ` ≤ ${euro(w.targetPrice)}` : ''}
            </span>
          ))}</div>
        ) : <Empty>Keine offenen Watchlist-Einträge.</Empty>}
      </div>
    </>
  );
}
