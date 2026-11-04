import { useState } from 'react';
import { api, type PurchaseDetail, type PurchaseSummary, type SearchHit } from '../api';
import { date, euro } from '../format';
import { Empty, ErrorNotice, NumInput, PO_STATUS_LABEL, StatusPill, useAsync, useToast } from '../ui';
import { ProductSearch } from './Watchlist';

const CONDS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
interface DraftLine { productId: number | null; name: string; setName: string | null; finish: string; condition: string; language: string; qty: number | null; unitPrice: number | null }

function NewPurchase({ onCreated }: { onCreated: (id: number) => void }) {
  const toast = useToast();
  const [supplier, setSupplier] = useState('');
  const [ref, setRef] = useState('');
  const [status, setStatus] = useState<'planned' | 'ordered' | 'paid'>('ordered');
  const [vat, setVat] = useState('none');
  const [shipping, setShipping] = useState<number | null>(null);
  const [other, setOther] = useState<number | null>(0);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const add = (h: SearchHit) => setLines(l => [...l, { productId: h.id, name: h.name, setName: h.setName, finish: 'nonfoil', condition: 'NM', language: 'en', qty: 1, unitPrice: null }]);
  const set = (i: number, patch: Partial<DraftLine>) => setLines(l => l.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const save = async () => {
    if (shipping == null) { toast('Bitte das Einkaufsporto angeben (0, falls keins).', true); return; }
    try {
      const r = await api.post<{ id: number }>('/api/purchases', {
        supplier: supplier || null, externalRef: ref || null, status, vatTreatment: vat, shippingCost: shipping, otherCosts: other ?? 0,
        lines: lines.map(l => ({ productId: l.productId, name: l.name, finish: l.finish, condition: l.condition, language: l.language, qty: l.qty, unitPrice: l.unitPrice })),
      });
      toast(`Einkauf #${r.id} angelegt.`);
      setLines([]); setSupplier(''); setRef('');
      onCreated(r.id);
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2>Neuer Einkauf</h2></div>
      <div className="form-grid">
        <label className="field">Verkäufer<input type="text" value={supplier} onChange={e => setSupplier(e.target.value)} /></label>
        <label className="field">Bestellnummer<input type="text" value={ref} onChange={e => setRef(e.target.value)} /></label>
        <label className="field">Status<select value={status} onChange={e => setStatus(e.target.value as 'planned')}><option value="planned">Geplant (Kapital reservieren)</option><option value="ordered">Bestellt</option><option value="paid">Bestellt und bezahlt</option></select></label>
        <label className="field">Steuer beim Einkauf<select value={vat} onChange={e => setVat(e.target.value)}><option value="none">ohne USt (Privatverkäufer / keine Rechnung)</option><option value="vat_invoice">Rechnung mit ausgewiesener USt</option><option value="margin_scheme">Händler mit Differenzbesteuerung</option></select></label>
        <label className="field">Porto gesamt €<NumInput value={shipping} onChange={setShipping} /></label>
        <label className="field">Sonstige Kosten €<NumInput value={other} onChange={setOther} /></label>
      </div>
      <div className="row" style={{ margin: '12px 0' }}><ProductSearch onPick={add} placeholder="Karte hinzufügen (Name, Set-Code oder Cardmarket-ID)" /></div>
      {lines.length > 0 && (
        <div className="table-wrap"><table className="compact">
          <thead><tr><th>Karte</th><th>Finish</th><th>Zustand</th><th>Sprache</th><th className="num">Menge</th><th className="num">Stückpreis €</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}><td>{l.name}<div className="small muted">{l.setName}</div></td>
              <td><select value={l.finish} onChange={e => set(i, { finish: e.target.value })}><option value="nonfoil">Nonfoil</option><option value="foil">Foil</option></select></td>
              <td><select value={l.condition} onChange={e => set(i, { condition: e.target.value })}>{CONDS.map(c => <option key={c}>{c}</option>)}</select></td>
              <td><input type="text" value={l.language} style={{ width: 50 }} onChange={e => set(i, { language: e.target.value.toLowerCase() })} /></td>
              <td className="num"><NumInput value={l.qty} onChange={v => set(i, { qty: v })} width={60} /></td>
              <td className="num"><NumInput value={l.unitPrice} onChange={v => set(i, { unitPrice: v })} width={80} /></td>
              <td><button className="btn small danger" onClick={() => setLines(x => x.filter((_, k) => k !== i))}>✕</button></td></tr>
          ))}</tbody>
        </table></div>
      )}
      <div className="row" style={{ marginTop: 10 }}><button className="btn primary" disabled={!lines.length} onClick={save}>Einkauf anlegen</button>
        <span className="small muted">Porto und Nebenkosten werden centgenau nach Warenwert auf die Positionen verteilt.</span></div>
    </div>
  );
}

function PurchaseView({ id, onChanged }: { id: number; onChanged: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useAsync(() => api.get<PurchaseDetail>(`/api/purchases/${id}`), [id]);
  const [recv, setRecv] = useState<Record<number, { qty: number | null; loc: string }>>({});
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg); reload(); onChanged(); } catch (e) { toast((e as Error).message, true); }
  };
  const status = (s: string) => {
    let body: Record<string, unknown> = { status: s };
    if (s === 'problem') { const note = prompt('Problem beschreiben:'); if (note == null) return; body.note = note; }
    if ((s === 'cancelled' || s === 'returned') && data?.paidAt) { const r = prompt('Erstatteter Betrag in € (0, falls nichts erstattet):'); if (r == null) return; body.refund = Number(r.replace(',', '.')); }
    void act(() => api.post(`/api/purchases/${id}/status`, body), `Status: ${PO_STATUS_LABEL[s]}`);
    body = {};
  };
  if (error) return <ErrorNotice error={error} />;
  if (!data) return null;
  const NEXT: Record<string, string[]> = { planned: ['ordered', 'paid', 'cancelled'], ordered: ['paid', 'problem', 'cancelled'], paid: ['problem', 'cancelled', 'returned'], partially_received: ['problem', 'returned'], received: ['returned'], problem: ['ordered', 'paid', 'cancelled', 'returned'] };
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-head"><h2>Einkauf #{data.id}</h2><StatusPill s={data.status} map={PO_STATUS_LABEL} /><span className="small muted">{data.supplier ?? 'ohne Verkäufer'}{data.externalRef ? ` · ${data.externalRef}` : ''}</span>
        <span className="spacer" />{(NEXT[data.status] ?? []).map(s => <button key={s} className={`btn small${s === 'cancelled' || s === 'returned' ? ' danger' : ''}`} onClick={() => status(s)}>{PO_STATUS_LABEL[s]}</button>)}
        {data.status === 'planned' && <button className="btn small danger" onClick={() => confirm('Geplanten Einkauf löschen?') && act(() => api.del(`/api/purchases/${id}`), 'Gelöscht.')}>Löschen</button>}</div>
      {data.problemNote && <div className="notice error">{data.problemNote}</div>}
      <div className="row small" style={{ marginBottom: 8 }}>
        <span>Ware {euro(data.goodsValue)} · Porto {euro(data.shippingCost)} · Sonstiges {euro(data.otherCosts)} · <strong>Gesamt {euro(data.total)}</strong></span>
        <span className="muted">Bestellt {date(data.orderedAt)} · Bezahlt {date(data.paidAt)} · Eingelagert {date(data.receivedAt)}</span>
        {data.refundAmount > 0 && <span>Erstattet {euro(data.refundAmount)}</span>}
        {!['cancelled', 'returned'].includes(data.status) && <button className="btn link small" onClick={() => {
          const v = prompt('Porto gesamt (€):', String(data.shippingCost)); if (v == null) return;
          void act(() => api.patch(`/api/purchases/${id}`, { shippingCost: Number(v.replace(',', '.')) }), 'Porto aktualisiert, Chargen neu belastet.');
        }}>Porto ändern</button>}
      </div>
      <div className="table-wrap"><table className="compact">
        <thead><tr><th>Karte</th><th>Variante</th><th className="num">Menge</th><th className="num">Stückpreis</th><th className="num">Nebenkosten</th><th className="num">Einstand/Stk</th><th>Eingang</th><th>Chargen</th><th /></tr></thead>
        <tbody>{data.lines.map(l => {
          const open = l.qty - l.receivedQty;
          const r = recv[l.id] ?? { qty: open, loc: '' };
          return (
            <tr key={l.id}><td>{l.name}<div className="small muted">{l.setName}</div></td><td className="small">{l.finish}{l.condition ? ' · ' + l.condition : ''}{l.language ? ' · ' + l.language : ''}</td>
              <td className="num">{l.qty}</td><td className="num">{euro(l.unitPrice)}</td><td className="num">{euro(l.allocatedCosts)}</td><td className="num">{euro(l.unitLandedCost)}</td>
              <td>{l.receivedQty}/{l.qty}</td><td className="small">{l.lots.map(x => x.code).join(', ')}</td>
              <td>{open > 0 && !['planned', 'cancelled', 'returned'].includes(data.status) && (
                <span className="row"><NumInput value={r.qty} onChange={v => setRecv(x => ({ ...x, [l.id]: { ...r, qty: v } }))} width={50} />
                  <input type="text" placeholder="Lagerplatz" value={r.loc} style={{ width: 80 }} onChange={e => setRecv(x => ({ ...x, [l.id]: { ...r, loc: e.target.value.toUpperCase() } }))} />
                  <button className="btn small good" onClick={() => act(() => api.post(`/api/purchases/lines/${l.id}/receive`, { qty: r.qty, locationCode: r.loc || null }), 'Wareneingang gebucht.')}>Einlagern</button></span>
              )}</td></tr>
          );
        })}</tbody>
      </table></div>
    </div>
  );
}

export function Purchases() {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [sel, setSel] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);
  const { data, error, reload } = useAsync(() => api.get<PurchaseSummary[]>(`/api/purchases${filter === 'open' ? '?open=1' : ''}`), [filter]);
  return (
    <>
      <div className="page-head"><h1>Purchase Manager</h1><span className="sub">Kauf, Zahlung und Wareneingang als getrennte Schritte</span>
        <div className="actions"><select value={filter} onChange={e => setFilter(e.target.value as 'open')}><option value="open">Offene Einkäufe</option><option value="all">Alle</option></select>
          <button className="btn primary" onClick={() => setShowNew(v => !v)}>{showNew ? 'Schließen' : 'Neuer Einkauf'}</button></div></div>
      {showNew && <NewPurchase onCreated={id => { setShowNew(false); setSel(id); reload(); }} />}
      <ErrorNotice error={error} />
      {data && (data.length === 0 ? <Empty>Keine Einkäufe. Im Deal-Scanner „Gekauft erfassen“ legt automatisch einen Einkauf an.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Verkäufer</th><th>Status</th><th className="num">Karten</th><th className="num">Eingang</th><th className="num">Ware</th><th className="num">Porto</th><th className="num">Gesamt</th><th>Bestellt</th><th>Bezahlt</th></tr></thead>
          <tbody>{data.map(p => (
            <tr key={p.id} className={`clickable${sel === p.id ? ' selected' : ''}`} onClick={() => setSel(p.id)}>
              <td>{p.id}</td><td>{p.supplier ?? '–'}{p.externalRef ? <div className="small muted">{p.externalRef}</div> : null}</td><td><StatusPill s={p.status} map={PO_STATUS_LABEL} /></td>
              <td className="num">{p.units}</td><td className="num">{p.receivedUnits}/{p.units}</td><td className="num">{euro(p.goodsValue)}</td><td className="num">{euro(p.shippingCost)}</td>
              <td className="num">{euro(p.total)}</td><td>{date(p.orderedAt)}</td><td>{date(p.paidAt)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {sel != null && <PurchaseView id={sel} onChanged={reload} />}
    </>
  );
}
