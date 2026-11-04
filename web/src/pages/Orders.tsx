import { useEffect, useState } from 'react';
import { api, qs, type Lot, type LotList, type OrderList, type SalesOrder } from '../api';
import { useShell } from '../App';
import { age, dateTime, euro, num } from '../format';
import { ALLOC_STATUS_LABEL, Empty, ErrorNotice, Money, NumInput, ORDER_STATUS_LABEL, StatusPill, useAsync, useToast } from '../ui';

interface DraftLine { lot: Lot; qty: number | null; unitPrice: number | null }

function LotPicker({ onPick }: { onPick: (l: Lot) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Lot[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => api.get<LotList>('/api/lots' + qs({ q, status: 'available', limit: 15 })).then(r => setHits(r.items)).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 280 }}>
      <input type="search" style={{ width: '100%' }} placeholder="Verfügbare Karte suchen oder Bestands-ID scannen" value={q} onChange={e => setQ(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && hits.length === 1) { onPick(hits[0]); setQ(''); setHits([]); } }} />
      {hits.length > 0 && (
        <div className="card" style={{ position: 'absolute', zIndex: 10, left: 0, right: 0, top: '110%', padding: 4, maxHeight: 320, overflowY: 'auto' }}>
          {hits.map(h => (
            <div key={h.id} className="row" style={{ padding: '5px 8px', cursor: 'pointer' }} onMouseDown={e => { e.preventDefault(); onPick(h); setQ(''); setHits([]); }}>
              <span>{h.name}</span><span className="small muted">{h.setName} · {h.condition}/{h.language}{h.finish === 'foil' ? ' Foil' : ''} · {h.code} · Platz {h.location ?? '–'}</span>
              <span className="spacer" /><span className="small">{h.qtyAvailable} frei · {euro(h.listPrice)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewOrder({ onCreated }: { onCreated: (id: number) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ platform: 'cardmarket', ext: '', buyer: '', country: '', address: '', paid: true });
  const [shipCharged, setShipCharged] = useState<number | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const save = async () => {
    if (shipCharged == null) { toast('Bitte das vom Käufer bezahlte Porto angeben (0, falls keins).', true); return; }
    try {
      const r = await api.post<{ id: number }>('/api/orders', {
        platform: f.platform, externalOrderId: f.ext || null, buyer: f.buyer || null, buyerCountry: f.country || null, shipAddress: f.address || null,
        paymentReceived: f.paid, shippingCharged: shipCharged, lines: lines.map(l => ({ lotId: l.lot.id, qty: l.qty, unitPrice: l.unitPrice })),
      });
      toast(`Auftrag #${r.id} angelegt – Karten reserviert.`); setLines([]); onCreated(r.id);
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2>Auftrag erfassen</h2></div>
      <div className="form-grid">
        <label className="field">Plattform<input type="text" value={f.platform} onChange={e => setF({ ...f, platform: e.target.value })} /></label>
        <label className="field">Auftragsnummer<input type="text" value={f.ext} onChange={e => setF({ ...f, ext: e.target.value })} /></label>
        <label className="field">Käufer<input type="text" value={f.buyer} onChange={e => setF({ ...f, buyer: e.target.value })} /></label>
        <label className="field">Land<input type="text" value={f.country} onChange={e => setF({ ...f, country: e.target.value })} /></label>
        <label className="field">Porto vom Käufer €<NumInput value={shipCharged} onChange={setShipCharged} /></label>
        <label className="check"><input type="checkbox" checked={f.paid} onChange={e => setF({ ...f, paid: e.target.checked })} /> Zahlung eingegangen</label>
      </div>
      <label className="field" style={{ marginTop: 8 }}>Lieferadresse (optional, nur für das Etikett, bleibt lokal)<textarea style={{ minHeight: 60 }} value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></label>
      <div className="row" style={{ margin: '10px 0' }}><LotPicker onPick={l => setLines(x => [...x, { lot: l, qty: 1, unitPrice: l.listPrice }])} /></div>
      {lines.length > 0 && <table className="compact"><tbody>{lines.map((l, i) => (
        <tr key={i}><td>{l.lot.name} <span className="small muted">{l.lot.code} · {l.lot.condition}/{l.lot.language} · {l.lot.qtyAvailable} frei</span></td>
          <td className="num">Menge <NumInput value={l.qty} onChange={v => setLines(x => x.map((y, k) => (k === i ? { ...y, qty: v } : y)))} width={50} /></td>
          <td className="num">Preis € <NumInput value={l.unitPrice} onChange={v => setLines(x => x.map((y, k) => (k === i ? { ...y, unitPrice: v } : y)))} width={70} /></td>
          <td><button className="btn small danger" onClick={() => setLines(x => x.filter((_, k) => k !== i))}>✕</button></td></tr>
      ))}</tbody></table>}
      <div className="row" style={{ marginTop: 10 }}><button className="btn primary" disabled={!lines.length} onClick={save}>Auftrag anlegen & reservieren</button></div>
    </div>
  );
}

function CsvImport({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [res, setRes] = useState<{ created: { orderId: number; externalOrderId: string }[]; duplicates: string[]; failed: { externalOrderId: string; rows: number[]; error: string }[] } | null>(null);
  const run = async () => { try { setRes(await api.post('/api/orders/import', { csv })); onDone(); } catch (e) { toast((e as Error).message, true); } };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <p className="small">Standard-CSV (<code>;</code> oder <code>,</code>): <code>order_id;platform;buyer;country;ordered_at;paid;shipping_charged;idProduct;name;set;condition;language;foil;qty;price</code>.
        Mehrere Zeilen mit gleicher order_id = ein Auftrag. Jeder Auftrag wird ganz oder gar nicht angelegt; Dubletten werden übersprungen.</p>
      <textarea value={csv} onChange={e => setCsv(e.target.value)} placeholder={'order_id;buyer;paid;shipping_charged;idProduct;condition;language;qty;price\nCM-1001;Anna;ja;1,25;152;NM;en;1;84,50'} />
      <div className="row" style={{ marginTop: 8 }}><button className="btn primary" disabled={!csv.trim()} onClick={run}>Importieren</button></div>
      {res && <div className="small" style={{ marginTop: 8 }}>
        <div className="pos">{res.created.length} Aufträge angelegt.</div>
        {res.duplicates.length > 0 && <div>Dubletten übersprungen: {res.duplicates.join(', ')}</div>}
        {res.failed.map(f => <div key={f.externalOrderId} className="neg">{f.externalOrderId} (Zeilen {f.rows.join(', ')}): {f.error}</div>)}
      </div>}
    </div>
  );
}

export function OrderDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useAsync(() => api.get<SalesOrder>(`/api/orders/${id}`), [id]);
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast(msg); reload(); onChanged(); } catch (e) { toast((e as Error).message, true); } };
  if (error) return <ErrorNotice error={error} />;
  if (!data) return null;
  const o = data;
  const status = (s: string, extra: Record<string, unknown> = {}) => act(() => api.post(`/api/orders/${id}/status`, { status: s, ...extra }), `Status: ${ORDER_STATUS_LABEL[s]}`);
  const r = o.result;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-head"><h2>Auftrag #{o.id}</h2><StatusPill s={o.status} map={ORDER_STATUS_LABEL} />
        <span className="small muted">{o.platform}{o.externalOrderId ? ` ${o.externalOrderId}` : ''} · {o.buyer ?? '–'} · Zahlung: {o.paymentStatus === 'received' ? 'eingegangen' : o.paymentStatus === 'refunded' ? 'erstattet' : 'offen'}</span>
        <span className="spacer" />
        {o.paymentStatus === 'open' && <button className="btn small" onClick={() => act(() => api.patch(`/api/orders/${id}`, { paymentReceived: true }), 'Zahlung bestätigt.')}>Zahlung eingegangen</button>}
        {o.status === 'new' && <button className="btn small primary" onClick={() => status('checked', { paymentReceived: o.paymentStatus === 'received' })}>Geprüft</button>}
        {o.status === 'shipped' && <button className="btn small primary" onClick={() => status('completed')}>Abschließen</button>}
        {o.status === 'problem' && <button className="btn small" onClick={() => act(() => api.post(`/api/orders/${id}/resolve`), 'Problem gelöst.')}>Problem gelöst</button>}
        {['new', 'checked', 'picking', 'packed', 'shipped'].includes(o.status) && <button className="btn small" onClick={() => { const n = prompt('Problem beschreiben:'); if (n) void status('problem', { note: n }); }}>Problem</button>}
        {['new', 'checked', 'picking', 'packed', 'problem'].includes(o.status) && !o.shippedAt && <button className="btn small danger" onClick={() => {
          if (!confirm('Auftrag stornieren? Reservierungen werden freigegeben.')) return;
          let refund: number | undefined;
          if (o.paymentStatus === 'received') { const v = prompt('Erstatteter Betrag €:', String(o.itemsValue + o.shippingCharged)); if (v == null) return; refund = Number(v.replace(',', '.')); }
          void status('cancelled', { refund });
        }}>Stornieren</button>}
      </div>
      {o.problemNote && <div className="notice error">{o.problemNote}</div>}
      {o.notes && <div className="notice info small" style={{ whiteSpace: 'pre-line' }}>{o.notes}</div>}
      <div className="table-wrap"><table className="compact">
        <thead><tr><th>Karte</th><th>Variante</th><th className="num">Menge</th><th className="num">Preis</th><th>Charge / Platz</th><th /></tr></thead>
        <tbody>{o.lines.map(l => (
          <tr key={l.id}><td>{l.name}<div className="small muted">{l.setName}</div></td><td className="small">{l.condition}/{l.language}{l.finish === 'foil' ? ' Foil' : ''}</td>
            <td className="num">{l.qty}{l.missingQty ? <span className="neg"> ({l.missingQty} fehlt)</span> : ''}{l.returnedQty ? <span className="muted"> ({l.returnedQty} zurück)</span> : ''}</td>
            <td className="num">{euro(l.unitPrice)}</td>
            <td className="small">{l.allocations.map(a => `${a.lotCode} @ ${a.location ?? '–'} ×${a.qty} (${ALLOC_STATUS_LABEL[a.status] ?? a.status})`).join(', ')}</td>
            <td className="row">
              {['new', 'checked', 'picking', 'packed', 'problem'].includes(o.status) && l.allocations.some(a => a.status === 'reserved') &&
                <button className="btn small danger" onClick={() => confirm('Karte nicht auffindbar? Sie wird aus dem Bestand ausgebucht und der Auftrag auf PROBLEM gesetzt.') && act(() => api.post(`/api/orders/lines/${l.id}/missing`, { qty: 1 }), 'Fehlende Karte gemeldet.')}>fehlt</button>}
              {l.missingQty > 0 && <>
                <button className="btn small" onClick={() => act(() => api.post(`/api/orders/lines/${l.id}/resolve-missing`, { mode: 'reallocate' }), 'Aus anderer Charge reserviert.')}>nachreservieren</button>
                <button className="btn small" onClick={() => act(() => api.post(`/api/orders/lines/${l.id}/resolve-missing`, { mode: 'drop' }), 'Position gekürzt.')}>kürzen</button></>}
              {o.shippedAt && l.qty - l.returnedQty > 0 && <button className="btn small" onClick={() => {
                const q = prompt(`Wie viele Exemplare kamen zurück? (max. ${l.qty - l.returnedQty})`, '1'); if (!q) return;
                const restock = confirm('Wieder einlagern? (Abbrechen = beschädigt/verloren, wird ausgebucht)');
                const refund = prompt('Erstatteter Betrag €:', String(Number(q) * l.unitPrice)); if (refund == null) return;
                void act(() => api.post(`/api/orders/${id}/return`, { items: [{ lineId: l.id, qty: Number(q), restock }], refund: Number(refund.replace(',', '.')) }), 'Rücksendung gebucht.');
              }}>Rücksendung</button>}
            </td></tr>
        ))}</tbody>
      </table></div>
      <div className="grid cols-2 section">
        <dl className="kv small">
          <dt>Warenwert</dt><dd>{euro(o.itemsValue)} + Porto Käufer {euro(o.shippingCharged)}</dd>
          <dt>Bestellt / bezahlt</dt><dd>{dateTime(o.orderedAt)} ({age(o.orderedAt)}) / {dateTime(o.paidAt)}</dd>
          <dt>Versendet</dt><dd>{dateTime(o.shippedAt)}{o.trackingNumber ? ` · ${o.carrier ?? ''} ${o.trackingNumber}` : ''}</dd>
          <dt>Kosten</dt><dd>Porto {euro(o.shippingCost)} · Verpackung {euro(o.packagingCost)} · Gebühr {euro(o.platformFee)}</dd>
          {o.refundAmount > 0 && <><dt>Erstattet</dt><dd>{euro(o.refundAmount)}</dd></>}
        </dl>
        {r ? (
          <dl className="kv small">
            <dt>Umsatz (brutto)</dt><dd>{euro(r.revenueGross)}</dd>
            <dt>Umsatzsteuer</dt><dd>{euro(r.outputVat)}</dd>
            <dt>Wareneinsatz</dt><dd>{euro(r.cogs)}</dd>
            <dt>Gebühren / Porto / Verp.</dt><dd>{euro(r.fees)} / {euro(r.shipping)} / {euro(r.packaging)}</dd>
            <dt>Deckungsbeitrag</dt><dd><strong><Money v={r.contribution} signed /></strong></dd>
            <dt>Arbeitszeit (kalk.)</dt><dd>{num(r.laborMinutes)} min = {euro(r.laborCost)} → nach Arbeit <Money v={r.profitAfterLabor} signed /></dd>
          </dl>
        ) : <div className="small muted">Ergebnis entsteht mit dem Versand (tatsächliche Kosten).</div>}
      </div>
    </div>
  );
}

export function Orders() {
  const { params } = useShell();
  const toast = useToast();
  const [view, setView] = useState<'active' | 'all' | 'archived'>('active');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<number | null>(params.get('order') ? Number(params.get('order')) : null);
  const [panel, setPanel] = useState<'none' | 'new' | 'csv'>('none');
  const { data, error, reload } = useAsync(() => api.get<OrderList>('/api/orders' + qs({ active: view === 'active', archived: view === 'archived', q, limit: 300 })), [view, q]);
  return (
    <>
      <div className="page-head"><h1>Sales Orders</h1><span className="sub">{data ? `${data.total} Aufträge` : ''}</span>
        <div className="actions">
          <button className="btn" onClick={() => setPanel(p => (p === 'csv' ? 'none' : 'csv'))}>CSV-Import</button>
          <button className="btn primary" onClick={() => setPanel(p => (p === 'new' ? 'none' : 'new'))}>Auftrag erfassen</button>
          <button className="btn" onClick={async () => { const r = await api.post<{ archived: number }>('/api/orders/archive', {}); toast(`${r.archived} alte Aufträge archiviert.`); reload(); }}>Alte archivieren</button>
          <a className="btn" href={'/api/orders.csv' + qs({ archived: view === 'archived' })}>CSV-Export</a>
        </div></div>
      <div className="notice info small">Aufträge werden manuell oder per CSV erfasst. Eine direkte Cardmarket-Synchronisierung ist ohne offiziell zugelassene Schnittstelle nicht eingebaut.</div>
      {panel === 'new' && <NewOrder onCreated={id => { setPanel('none'); setSel(id); reload(); }} />}
      {panel === 'csv' && <CsvImport onDone={reload} />}
      <div className="filters">
        <label className="field">Ansicht<select value={view} onChange={e => setView(e.target.value as 'active')}><option value="active">Offen</option><option value="all">Alle (nicht archiviert)</option><option value="archived">Archiv</option></select></label>
        <label className="field">Suche<input type="search" value={q} placeholder="Auftrag, Käufer, Karte" onChange={e => setQ(e.target.value)} /></label>
      </div>
      <ErrorNotice error={error} />
      {data && (data.items.length === 0 ? <Empty>Keine Aufträge.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Auftrag</th><th>Käufer</th><th>Status</th><th>Zahlung</th><th className="num">Karten</th><th className="num">Wert</th><th>Bestellt</th><th className="num">Deckungsbeitrag</th></tr></thead>
          <tbody>{data.items.map(o => (
            <tr key={o.id} className={`clickable${sel === o.id ? ' selected' : ''}${o.overdue ? ' overdue' : ''}`} onClick={() => setSel(o.id)} title={o.overdue ? 'überfällig' : undefined}>
              <td>{o.id}{o.priority > 0 ? ' ★' : ''}</td><td>{o.platform}{o.externalOrderId ? ` ${o.externalOrderId}` : ''}</td><td>{o.buyer ?? '–'}</td>
              <td><StatusPill s={o.status} map={ORDER_STATUS_LABEL} />{o.missing ? <span className="neg small"> {o.missing} fehlt</span> : null}</td>
              <td className="small">{o.paymentStatus === 'received' ? '✓' : o.paymentStatus === 'refunded' ? 'erstattet' : 'offen'}</td>
              <td className="num">{o.units}</td><td className="num">{euro(o.itemsValue + o.shippingCharged)}</td><td className="small">{age(o.orderedAt)}</td>
              <td className="num">{o.result ? <Money v={o.result.contribution} signed /> : <span className="muted">–</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {sel != null && <OrderDetail id={sel} onChanged={reload} />}
    </>
  );
}
