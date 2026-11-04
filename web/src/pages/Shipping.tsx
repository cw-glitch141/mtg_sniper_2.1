import { useState } from 'react';
import { api, type AppSettings, type OrderList, type Picklist, type SalesOrder } from '../api';
import { age, dateTime, euro } from '../format';
import { Empty, ErrorNotice, NumInput, ORDER_STATUS_LABEL, StatusPill, useAsync, useToast } from '../ui';

function PickTable({ list, onClose }: { list: Picklist; onClose: () => void }) {
  const [done, setDone] = useState<Set<number>>(new Set());
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2>Pickliste</h2><span className="small muted">{dateTime(list.createdAt)} · {list.orders} Aufträge · {list.items.reduce((a, i) => a + i.qty, 0)} Karten</span>
        <span className="spacer" /><button className="btn no-print" onClick={() => window.print()}>Drucken</button><button className="btn no-print" onClick={onClose}>Schließen</button></div>
      {list.warnings.map(w => <div key={w} className="notice warn small no-print">{w}</div>)}
      <table className="compact">
        <thead><tr><th>✓</th><th>Lagerplatz</th><th>Charge</th><th>Karte</th><th>Variante</th><th className="num">Menge</th><th>Aufträge</th></tr></thead>
        <tbody>{list.items.map(i => (
          <tr key={i.lotId} style={{ opacity: done.has(i.lotId) ? 0.45 : 1 }}>
            <td><input type="checkbox" checked={done.has(i.lotId)} onChange={() => setDone(s => { const n = new Set(s); if (n.has(i.lotId)) n.delete(i.lotId); else n.add(i.lotId); return n; })} /></td>
            <td><strong>{i.warehouse && i.warehouse !== 'HAUPT' ? i.warehouse + ' / ' : ''}{i.location ?? '– ohne Platz –'}</strong></td><td className="small">{i.lotCode}</td>
            <td>{i.name}<div className="small muted">{i.setName}</div></td><td className="small">{i.condition}/{i.language}{i.finish === 'foil' ? ' Foil' : ''}</td>
            <td className="num"><strong>{i.qty}</strong></td><td className="small">{i.orders.map(o => `${o.ref} ×${o.qty}`).join(', ')}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function PackCard({ o, s, onDone }: { o: SalesOrder; s: AppSettings; onDone: () => void }) {
  const toast = useToast();
  const tracked = o.itemsValue >= s.business.trackedFromOrderValue;
  const [shipCost, setShipCost] = useState<number | null>(o.shippingCost ?? (tracked ? s.business.defaultTrackedShippingCost : s.business.defaultShippingCost));
  const [pack, setPack] = useState<number | null>(o.packagingCost ?? s.business.defaultPackagingCost);
  const [fee, setFee] = useState<number | null>(o.platformFee ?? Math.round(o.itemsValue * s.fees.commissionPct) / 100);
  const [tracking, setTracking] = useState(o.trackingNumber ?? '');
  const [carrier, setCarrier] = useState(o.carrier ?? (tracked ? 'DHL/Einschreiben' : 'Brief'));
  const allocs = o.lines.flatMap(l => l.allocations.filter(a => a.status === 'reserved').map(a => ({ ...a, name: l.name, cond: l.condition, lang: l.language })));
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [scan, setScan] = useState('');
  const allChecked = allocs.length > 0 && allocs.every(a => checked.has(a.id));
  const doScan = () => {
    const code = scan.trim().toUpperCase();
    const hit = allocs.find(a => a.lotCode === code || a.lotCode === 'L' + code.padStart(6, '0'));
    if (hit) setChecked(c => new Set(c).add(hit.id)); else toast(`${code} gehört nicht zu diesem Auftrag!`, true);
    setScan('');
  };
  const status = async (st: string) => {
    try {
      await api.post(`/api/orders/${o.id}/status`, st === 'shipped'
        ? { status: st, shippingCost: shipCost, packagingCost: pack, platformFee: fee, trackingNumber: tracking || null, carrier: carrier || null }
        : { status: st });
      toast(`#${o.id}: ${ORDER_STATUS_LABEL[st]}`); onDone();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="card">
      <div className="card-head"><h2>#{o.id} {o.externalOrderId ?? ''}</h2><StatusPill s={o.status} map={ORDER_STATUS_LABEL} /><span className="small muted">{o.buyer ?? ''} · {age(o.orderedAt)}{o.overdue ? ' · überfällig' : ''}</span></div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="scan" placeholder="Bestands-ID scannen zum Abhaken" value={scan} onChange={e => setScan(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') doScan(); }} />
      </div>
      <ul className="checklist">
        {allocs.map(a => (
          <li key={a.id}><input type="checkbox" checked={checked.has(a.id)} onChange={() => setChecked(c => { const n = new Set(c); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} />
            <strong>{a.qty}×</strong> {a.name} <span className="small muted">{a.cond}/{a.lang} · {a.lotCode} · Platz {a.location ?? '–'}</span></li>
        ))}
        <li><input type="checkbox" checked={checked.has(-1)} onChange={() => setChecked(c => { const n = new Set(c); if (n.has(-1)) n.delete(-1); else n.add(-1); return n; })} /> Zustand geprüft, Schutzhülle + Toploader, Umschlag beschriftet</li>
      </ul>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <label className="field">Porto (tatsächlich) €<NumInput value={shipCost} onChange={setShipCost} /></label>
        <label className="field">Verpackung €<NumInput value={pack} onChange={setPack} /></label>
        <label className="field">Plattformgebühr €<NumInput value={fee} onChange={setFee} /></label>
        <label className="field">Versandart<input type="text" value={carrier} onChange={e => setCarrier(e.target.value)} /></label>
        <label className="field">Sendungsnummer<input type="text" value={tracking} onChange={e => setTracking(e.target.value)} /></label>
        <div className="hint">Vorbelegt aus den Einstellungen ({tracked ? 'versichert ab ' + euro(s.business.trackedFromOrderValue) : 'Brief'}; Gebühr {s.fees.commissionPct} % vom Warenwert) – bitte tatsächliche Werte prüfen.</div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {(o.status === 'checked' || o.status === 'picking') && <button className="btn" disabled={!allChecked} onClick={() => status('packed')}>Gepackt</button>}
        {o.status === 'packed' && <button className="btn good" onClick={() => status('shipped')}>Versendet</button>}
        {!allChecked && o.status !== 'packed' && <span className="small muted">Erst alle Karten abhaken.</span>}
        <span className="spacer" />
        {o.shipAddress && <button className="btn small" onClick={() => {
          const w = window.open('', '_blank', 'width=420,height=300');
          if (!w) return;
          w.document.title = `Etikett #${o.id}`;
          const pre = w.document.createElement('pre');
          pre.style.font = '14pt sans-serif';
          pre.textContent = `${o.shipAddress}\n\nAuftrag ${o.externalOrderId ?? '#' + o.id}`;
          w.document.body.append(pre);
          w.print();
        }}>Adressetikett</button>}
      </div>
    </div>
  );
}

export function Shipping() {
  const toast = useToast();
  const { data, error, reload } = useAsync(() => api.get<OrderList>('/api/orders?active=1&limit=500'), []);
  const settings = useAsync(() => api.get<{ settings: AppSettings }>('/api/settings'), []);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [pick, setPick] = useState<Picklist | null>(null);
  const ready = (data?.items ?? []).filter(o => ['checked', 'picking', 'packed'].includes(o.status));
  const waiting = (data?.items ?? []).filter(o => o.status === 'new' || o.status === 'problem');
  const makePick = async () => {
    try { setPick(await api.post<Picklist>('/api/picklist', { orderIds: [...sel], markPicking: true })); reload(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      <div className="page-head no-print"><h1>Shipping Center</h1><span className="sub">Mehrere Aufträge in einem Durchgang: Pickliste → Packen → Versenden</span>
        <div className="actions"><button className="btn" onClick={() => setSel(new Set(ready.filter(o => o.status !== 'packed').map(o => o.id)))}>Alle zum Picken wählen</button>
          <button className="btn primary" disabled={!sel.size} onClick={makePick}>Pickliste ({sel.size})</button></div></div>
      <ErrorNotice error={error} />
      {pick && <PickTable list={pick} onClose={() => setPick(null)} />}
      {waiting.length > 0 && <div className="notice warn small no-print">{waiting.length} Auftrag/Aufträge warten auf Prüfung oder haben ein Problem (Sales Orders): {waiting.map(o => `#${o.id}`).join(', ')}</div>}
      {data && (ready.length === 0 ? <Empty>Keine geprüften Aufträge zum Versand.</Empty> : (
        <div className="no-print">
          <div className="table-wrap" style={{ marginBottom: 16 }}><table className="compact">
            <thead><tr><th /><th>#</th><th>Auftrag</th><th>Status</th><th className="num">Karten</th><th className="num">Wert</th><th>Alter</th></tr></thead>
            <tbody>{ready.map(o => (
              <tr key={o.id} className={o.overdue ? 'overdue' : ''}><td><input type="checkbox" checked={sel.has(o.id)} onChange={() => setSel(s => { const n = new Set(s); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })} /></td>
                <td>{o.id}</td><td>{o.externalOrderId ?? '–'} · {o.buyer ?? ''}</td><td><StatusPill s={o.status} map={ORDER_STATUS_LABEL} /></td><td className="num">{o.units}</td><td className="num">{euro(o.itemsValue)}</td><td>{age(o.orderedAt)}</td></tr>
            ))}</tbody>
          </table></div>
          {settings.data && <div className="grid cols-2">{ready.map(o => <PackCard key={o.id + o.status} o={o} s={settings.data!.settings} onDone={reload} />)}</div>}
        </div>
      ))}
    </>
  );
}
