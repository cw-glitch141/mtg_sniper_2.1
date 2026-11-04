import { useState } from 'react';
import { api, type AlertItem, type Movers, type OppList } from '../api';
import { useShell } from '../App';
import { OppTable } from '../components/OppTable';
import { age, euro, pct } from '../format';
import { Empty, ErrorNotice, SignalBadge, useAsync } from '../ui';

export function MarketWatch() {
  const { openProduct } = useShell();
  const [win, setWin] = useState<1 | 7 | 30>(1);
  const signals = useAsync(() => api.get<OppList>('/api/opportunities?signalClass=MARKET_SIGNAL&limit=50'), []);
  const down = useAsync(() => api.get<Movers>(`/api/movers?window=${win}&dir=down&limit=15`), [win]);
  const up = useAsync(() => api.get<Movers>(`/api/movers?window=${win}&dir=up&limit=15`), [win]);
  const watch = useAsync(() => api.get<AlertItem[]>('/api/alerts?priority=WATCH&limit=30'), []);
  const moverTable = (m: Movers | null) => m && (m.items.length ? (
    <>
      <div className="small muted" style={{ marginBottom: 6 }}>{m.note}</div>
      <table className="compact"><tbody>{m.items.map(r => (
        <tr key={`${r.productId}-${r.finish}`} className="clickable" onClick={() => openProduct(r.productId)}>
          <td className="wrap">{r.name}{r.finish === 'foil' ? ' (Foil)' : ''}<div className="small muted">{r.setName}</div></td>
          <td className="num small">{euro(r.fromPrice)} → {euro(r.toPrice)}</td><td className={`num ${r.changePct < 0 ? 'neg' : 'pos'}`}>{pct(r.changePct, true)}</td></tr>
      ))}</tbody></table>
    </>
  ) : <Empty>Keine Daten.</Empty>);
  return (
    <>
      <div className="page-head"><h1>Market Watch</h1><span className="sub">Preisentwicklungen und Auffälligkeiten – kein kaufbares Angebot</span>
        <div className="actions"><select value={win} onChange={e => setWin(Number(e.target.value) as 1)}><option value={1}>1 Tag</option><option value={7}>7 Tage</option><option value={30}>30 Tage</option></select></div></div>
      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="card"><div className="card-head"><h2>Stärkste Rückgänge</h2></div><ErrorNotice error={down.error} />{moverTable(down.data)}</div>
        <div className="card"><div className="card-head"><h2>Stärkste Anstiege</h2></div><ErrorNotice error={up.error} />{moverTable(up.data)}</div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>Marktsignale</h2><a className="more" href="#/scanner">Alle im Scanner →</a></div>
        {signals.data && (signals.data.items.length ? <OppTable items={signals.data.items} onOpen={o => openProduct(o.productId, o.key)} compact /> : <Empty>Keine Marktsignale.</Empty>)}
      </div>
      <div className="card">
        <div className="card-head"><h2>MARKET-WATCH-Alarme</h2></div>
        {watch.data && (watch.data.length ? watch.data.map(a => (
          <div key={a.id} className="small" style={{ marginBottom: 8 }}><SignalBadge c={a.signalClass} /> <span className="muted">{age(a.createdAt)}</span><div>{a.title}</div><div className="muted" style={{ whiteSpace: 'pre-line' }}>{a.message}</div></div>
        )) : <Empty>Keine.</Empty>)}
      </div>
    </>
  );
}
