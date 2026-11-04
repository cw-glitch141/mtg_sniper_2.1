import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api, qs, type Location, type Lot, type LotList, type Movement, type Reprice } from '../api';
import { useShell } from '../App';
import { date, dateTime, euro, int, pct } from '../format';
import { Empty, ErrorNotice, NumInput, PO_STATUS_LABEL, useAsync, useToast } from '../ui';
import { ProductSearch } from './Watchlist';

const CONDS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];

/** QR-Code als SVG (Inhalt: Bestands-ID, z. B. L000123 – mit jedem Handscanner ins Suchfeld scannbar). */
export function Qr({ text, size = 25 }: { text: string; size?: number }) {
  const cells = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const out: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) out.push([c, r]);
    return { n, out };
  }, [text]);
  return (
    <svg viewBox={`-2 -2 ${cells.n + 4} ${cells.n + 4}`} width={`${size}mm`} height={`${size}mm`} role="img" aria-label={`QR-Code ${text}`} shapeRendering="crispEdges">
      <rect x={-2} y={-2} width={cells.n + 4} height={cells.n + 4} fill="#fff" />
      {cells.out.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#000" />)}
    </svg>
  );
}

export function LabelSheet({ lots, onClose }: { lots: Lot[]; onClose: () => void }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="card" style={{ width: 'min(900px, 100%)' }} onClick={e => e.stopPropagation()}>
        <div className="card-head no-print"><h2>Etiketten ({lots.length})</h2><span className="spacer" /><button className="btn primary" onClick={() => window.print()}>Drucken</button><button className="btn" onClick={onClose}>Schließen</button></div>
        <p className="small muted no-print">62 × 29 mm (Brother-QL-kompatibel) oder auf A4 ausschneiden. Der QR-Code enthält die Bestands-ID – im Suchfeld von Lager und Versand scannbar.</p>
        <div className="labels">
          {lots.map(l => (
            <div key={l.id} className="label-card">
              <Qr text={l.code} />
              <div className="t"><strong>{l.code}</strong>{l.name}<br />{l.setCode ?? l.setName ?? ''}{l.collectorNumber ? ` #${l.collectorNumber}` : ''}<br />
                {[l.condition, l.language?.toUpperCase(), l.finish === 'foil' ? 'Foil' : null].filter(Boolean).join(' · ')}<br />Platz {l.location ?? '–'} · {l.qtyOnHand} Stk</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LotDialog({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { data, reload } = useAsync(() => api.get<{ lot: Lot; movements: Movement[] }>(`/api/lots/${id}`), [id]);
  const [loc, setLoc] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  const [minP, setMinP] = useState<number | null>(null);
  const [splitQty, setSplitQty] = useState<number | null>(1);
  const [splitLoc, setSplitLoc] = useState('');
  const [deck, setDeck] = useState('');
  useEffect(() => { if (data) { setLoc(data.lot.location ?? ''); setPrice(data.lot.listPrice); setMinP(data.lot.minPriceOverride); } }, [data]);
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast(msg); reload(); onChanged(); } catch (e) { toast((e as Error).message, true); } };
  if (!data) return null;
  const l = data.lot;
  return (
    <div className="modal" onClick={onClose}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ width: 'min(760px, 100%)' }}>
        <div className="card-head"><h2>{l.code} · {l.name}</h2><span className="small muted">{l.setName}</span><span className="spacer" /><button className="btn small" onClick={onClose}>✕</button></div>
        <dl className="kv">
          <dt>Variante</dt><dd>{l.finish} · {l.condition ?? '?'} · {l.language ?? '?'}{l.ownership === 'private' ? ` · PRIVAT${l.privateDeck ? ' (' + l.privateDeck + ')' : ''}` : ''}</dd>
          <dt>Menge</dt><dd>{l.qtyOnHand} im Lager · {l.qtyReserved} reserviert · {l.qtyAvailable} verfügbar · {l.qtySold} verkauft (von {l.qtyReceived} eingegangen)</dd>
          <dt>Einstand</dt><dd>{euro(l.unitCost)} + {euro(l.unitAlloc)} Nebenkosten = <strong>{euro(l.unitFullCost)}</strong> je Stück · Steuer: {l.vatTreatment}</dd>
          <dt>Eingang</dt><dd>{date(l.receivedAt)} ({l.ageDays} Tage){l.slow ? ' · langsam verkäuflich' : ''}{l.purchaseOrderId ? ` · Einkauf #${l.purchaseOrderId}` : ''}</dd>
          <dt>Erlös realisiert</dt><dd>{euro(l.realizedRevenue)}</dd>
        </dl>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <label className="field">Lagerplatz<span className="row"><input type="text" value={loc} style={{ width: 90 }} onChange={e => setLoc(e.target.value.toUpperCase())} />
            <button className="btn small" onClick={() => act(() => api.patch(`/api/lots/${id}`, { locationCode: loc || null }), 'Lagerplatz gespeichert.')}>OK</button></span></label>
          {l.ownership === 'business' && <label className="field">Angebotspreis €<span className="row"><NumInput value={price} onChange={setPrice} width={80} />
            <button className="btn small" onClick={() => price == null ? act(() => api.patch(`/api/lots/${id}`, { listPrice: null }), 'Angebot entfernt.') : act(async () => {
              try { await api.post('/api/repricing/apply', { items: [{ lotId: id, price }] }).then((r: unknown) => { const x = r as { errors: { error: string }[] }; if (x.errors.length) throw new Error(x.errors[0].error); }); }
              catch (e) { if (/Untergrenze/.test((e as Error).message) && confirm((e as Error).message + '\n\nTrotzdem übernehmen?')) await api.post('/api/repricing/apply', { items: [{ lotId: id, price, acceptBelowFloor: true }] }); else throw e; }
            }, 'Preis gespeichert.')}>OK</button></span></label>}
          {l.ownership === 'business' && <label className="field">Eigene Mindestgrenze €<span className="row"><NumInput value={minP} onChange={setMinP} width={80} />
            <button className="btn small" onClick={() => act(() => api.patch(`/api/lots/${id}`, { minPriceOverride: minP }), 'Mindestgrenze gespeichert.')}>OK</button></span></label>}
        </div>
        <div className="card section">
          <h3 style={{ marginBottom: 8 }}>Teilmenge umlagern / Geschäft ↔ Privat</h3>
          <div className="row">
            <label className="field">Menge<NumInput value={splitQty} onChange={setSplitQty} width={60} /></label>
            <label className="field">Neuer Lagerplatz<input type="text" value={splitLoc} style={{ width: 90 }} onChange={e => setSplitLoc(e.target.value.toUpperCase())} /></label>
            <button className="btn small" style={{ alignSelf: 'flex-end' }} onClick={() => act(() => api.post(`/api/lots/${id}/split`, { qty: splitQty, locationCode: splitLoc || null }), 'Umgelagert.')}>Umlagern</button>
            {l.ownership === 'business'
              ? <><label className="field">Deck (optional)<input type="text" value={deck} onChange={e => setDeck(e.target.value)} /></label>
                <button className="btn small danger" style={{ alignSelf: 'flex-end' }} onClick={() => confirm('Exemplare in den Privatbestand verschieben? Sie zählen dann nicht mehr zum Handelsbestand.') && act(() => api.post(`/api/lots/${id}/split`, { qty: splitQty, ownership: 'private', privateDeck: deck || null }), 'In Privatbestand verschoben.')}>→ Privat</button></>
              : <button className="btn small" style={{ alignSelf: 'flex-end' }} onClick={() => act(() => api.post(`/api/lots/${id}/split`, { qty: splitQty, ownership: 'business' }), 'In Handelsbestand übernommen.')}>→ Handelsbestand</button>}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => { const d = prompt('Bestandskorrektur (z. B. -1 oder 2):'); const r = d && prompt('Grund (Inventur, beschädigt …):'); if (d && r) void act(() => api.post(`/api/lots/${id}/adjust`, { delta: Number(d), reason: r }), 'Korrektur gebucht.'); }}>Inventurkorrektur</button>
          </div>
        </div>
        <div className="section"><h3>Bewegungen</h3>
          <table className="compact"><tbody>{data.movements.map(m => (
            <tr key={m.id}><td className="small">{dateTime(m.createdAt)}</td><td>{m.type}</td><td className="num">{m.qty > 0 ? '+' : ''}{m.qty}</td><td className="small muted wrap">{m.note ?? ''}{m.refType ? ` (${m.refType} ${m.refId})` : ''}</td></tr>
          ))}</tbody></table></div>
      </div>
    </div>
  );
}

function StockList({ ownership }: { ownership: 'business' | 'private' }) {
  const { openProduct } = useShell();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('onhand');
  const [slow, setSlow] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<number | null>(null);
  const [labels, setLabels] = useState<Lot[] | null>(null);
  useEffect(() => { const t = setTimeout(() => setQuery(q), 250); return () => clearTimeout(t); }, [q]);
  const { data, error, reload } = useAsync(() => api.get<LotList>('/api/lots' + qs({ q: query, ownership, status, slow, limit: 500 })), [query, ownership, status, slow]);
  const toggle = (id: number) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const totals = data?.items.reduce((a, l) => ({ units: a.units + l.qtyOnHand, cost: a.cost + l.qtyOnHand * l.unitFullCost }), { units: 0, cost: 0 });
  return (
    <>
      <div className="filters">
        <label className="field">Suche / Scan<input className="scan" type="search" autoFocus placeholder="Name, Bestands-ID (L000123), Lagerplatz, Cardmarket-ID" value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && data?.items.length === 1) setDialog(data.items[0].id); }} /></label>
        <label className="field">Status<select value={status} onChange={e => setStatus(e.target.value)}>
          <option value="onhand">im Lager</option><option value="available">verfügbar</option><option value="reserved">reserviert</option><option value="listed">angeboten</option>
          <option value="unlisted">nicht angeboten</option><option value="soldout">ausverkauft</option><option value="all">alle</option></select></label>
        {ownership === 'business' && <label className="check"><input type="checkbox" checked={slow} onChange={e => setSlow(e.target.checked)} /> nur langsam verkäuflich</label>}
        <span className="spacer" />
        <button className="btn" disabled={!sel.size} onClick={() => setLabels((data?.items ?? []).filter(l => sel.has(l.id)))}>Etiketten ({sel.size})</button>
        <a className="btn" href={'/api/lots.csv' + qs({ ownership, status })}>CSV-Export</a>
      </div>
      <ErrorNotice error={error} />
      {totals && <p className="small muted">{data?.total} Chargen · {int(totals.units)} Exemplare · Einstand {euro(totals.cost)}{ownership === 'private' ? ' (Privatbestand, nicht in Geschäftszahlen enthalten)' : ''}</p>}
      {data && (data.items.length === 0 ? <Empty>{ownership === 'private' ? 'Kein Privatbestand.' : 'Kein Bestand. Wareneingang im Purchase Manager oder „Anfangsbestand“ erfassen.'}</Empty> : (
        <div className="table-wrap"><table className="compact">
          <thead><tr><th><input type="checkbox" aria-label="alle" checked={sel.size > 0 && sel.size === data.items.length} onChange={e => setSel(e.target.checked ? new Set(data.items.map(l => l.id)) : new Set())} /></th>
            <th>ID</th><th>Platz</th><th>Karte</th><th>Variante</th><th className="num">Lager</th><th className="num">Res.</th><th className="num">Frei</th><th className="num">Einstand</th>
            <th>Eingang</th><th>Lieferung</th><th>Verkauf</th><th className="num">Angebot</th><th className="num">Trend</th></tr></thead>
          <tbody>{data.items.map(l => (
            <tr key={l.id} className={`clickable${l.slow ? ' overdue' : ''}`} onClick={() => setDialog(l.id)}>
              <td onClick={e => e.stopPropagation()}><input type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} /></td>
              <td className="small">{l.code}</td><td>{l.location ?? <span className="muted">–</span>}</td>
              <td>{l.productId ? <button className="btn link" onClick={e => { e.stopPropagation(); openProduct(l.productId as number); }}>{l.name}</button> : l.name}<div className="small muted">{l.setName}{l.collectorNumber ? ` #${l.collectorNumber}` : ''}{l.privateDeck ? ` · Deck ${l.privateDeck}` : ''}</div></td>
              <td className="small">{l.condition ?? '?'}/{l.language ?? '?'}{l.finish === 'foil' ? ' Foil' : ''}</td>
              <td className="num">{l.qtyOnHand}</td><td className="num">{l.qtyReserved || ''}</td><td className="num">{l.qtyAvailable}</td><td className="num">{euro(l.unitFullCost)}</td>
              <td className="small">{date(l.receivedAt)}<div className="muted">{l.ageDays} T.</div></td><td className="small">{l.deliveryStatus ? (PO_STATUS_LABEL[l.deliveryStatus] ?? l.deliveryStatus) : '–'}</td><td className="small">{l.salesStatus}</td>
              <td className="num">{euro(l.listPrice)}</td><td className="num">{euro(l.marketTrend)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {dialog != null && <LotDialog id={dialog} onClose={() => setDialog(null)} onChanged={reload} />}
      {labels && <LabelSheet lots={labels} onClose={() => setLabels(null)} />}
    </>
  );
}

function Repricing() {
  const toast = useToast();
  const [onlyAct, setOnlyAct] = useState(true);
  const { data, error, reload } = useAsync(() => api.get<Reprice[]>('/api/repricing' + (onlyAct ? '?actionable=1' : '')), [onlyAct]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const apply = async (items: Reprice[]) => {
    const r = await api.post<{ applied: number; errors: { lotId: number; error: string }[] }>('/api/repricing/apply', { items: items.filter(i => i.suggested != null).map(i => ({ lotId: i.lotId, price: i.suggested })) });
    toast(`${r.applied} Preis(e) übernommen${r.errors.length ? `, ${r.errors.length} Fehler: ${r.errors[0].error}` : ''}.`, r.errors.length > 0);
    setSel(new Set()); reload();
  };
  return (
    <>
      <div className="notice info small">Vorschläge, keine automatische Änderung: Ohne autorisierte Marktplatz-Schnittstelle übernimmst du Preise hier ins Lager und trägst sie selbst auf Cardmarket ein (CSV-Export als Arbeitsliste).
        Kein Vorschlag liegt unter der Untergrenze = max(Verlustgrenze aus tatsächlichem Einstand, Gebühren und Steuer; absoluter Mindestpreis; eigene Mindestgrenze).</div>
      <div className="filters"><label className="check"><input type="checkbox" checked={onlyAct} onChange={e => setOnlyAct(e.target.checked)} /> nur Handlungsbedarf</label><span className="spacer" />
        <button className="btn primary" disabled={!sel.size} onClick={() => data && apply(data.filter(d => sel.has(d.lotId)))}>Auswahl übernehmen ({sel.size})</button>
        <a className="btn" href="/api/repricing.csv">CSV-Arbeitsliste</a></div>
      <ErrorNotice error={error} />
      {data && (data.length === 0 ? <Empty>Kein Handlungsbedarf.</Empty> : (
        <div className="table-wrap"><table className="compact">
          <thead><tr><th /><th>ID</th><th>Karte</th><th className="num">Frei</th><th className="num">Einstand</th><th className="num">Verlustgrenze</th><th className="num">Zielpreis</th><th className="num">Marktwert</th>
            <th className="num">Markt ggü. Einstand</th><th className="num">Angebot</th><th className="num">Tage</th><th>Befund</th><th className="num">Vorschlag</th></tr></thead>
          <tbody>{data.map(r => (
            <tr key={r.lotId} title={r.notes.join('\n')}>
              <td>{r.suggested != null && <input type="checkbox" checked={sel.has(r.lotId)} onChange={() => setSel(s => { const n = new Set(s); if (n.has(r.lotId)) n.delete(r.lotId); else n.add(r.lotId); return n; })} />}</td>
              <td className="small">{r.lotCode}</td><td>{r.name}<div className="small muted">{r.setName} · {r.condition}/{r.language}{r.finish === 'foil' ? ' Foil' : ''}</div></td>
              <td className="num">{r.qtyAvailable}</td><td className="num">{euro(r.unitFullCost)}</td><td className="num">{euro(r.breakEven)}</td><td className="num">{euro(r.target)}</td>
              <td className="num">{euro(r.marketBase)}</td><td className={`num ${(r.marketVsCostPct ?? 0) < 0 ? 'neg' : 'pos'}`}>{pct(r.marketVsCostPct, true)}</td>
              <td className="num">{euro(r.listPrice)}</td><td className="num">{r.daysListed ?? '–'}</td>
              <td className={r.action === 'below_floor' ? 'neg' : ''}>{r.actionLabel}{r.notes.length > 0 && <span className="muted"> ⓘ</span>}</td>
              <td className="num"><strong>{euro(r.suggested)}</strong></td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
    </>
  );
}

function Locations() {
  const toast = useToast();
  const { data, reload } = useAsync(() => api.get<Location[]>('/api/locations'), []);
  const [from, setFrom] = useState('A01');
  const [to, setTo] = useState('A20');
  const [wh, setWh] = useState('');
  const create = async () => {
    const m1 = /^([A-Z]+)(\d+)$/.exec(from.trim().toUpperCase()), m2 = /^([A-Z]+)(\d+)$/.exec(to.trim().toUpperCase());
    if (!m1 || !m2 || m1[1] !== m2[1]) { toast('Bereich wie A01 bis A20 angeben.', true); return; }
    const w = m1[2].length, a = Number(m1[2]), b = Number(m2[2]);
    if (b < a || b - a > 500) { toast('Ungültiger Bereich.', true); return; }
    const codes = Array.from({ length: b - a + 1 }, (_, i) => m1[1] + String(a + i).padStart(w, '0'));
    try { await api.post('/api/locations', { codes, warehouse: wh || null }); toast(`${codes.length} Lagerplätze angelegt.`); reload(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      <div className="card filters">
        <label className="field">Von<input type="text" value={from} onChange={e => setFrom(e.target.value)} style={{ width: 80 }} /></label>
        <label className="field">Bis<input type="text" value={to} onChange={e => setTo(e.target.value)} style={{ width: 80 }} /></label>
        <label className="field">Lager (optional)<input type="text" value={wh} placeholder="HAUPT" onChange={e => setWh(e.target.value.toUpperCase())} style={{ width: 100 }} /></label>
        <button className="btn primary" onClick={create}>Lagerplätze anlegen</button>
      </div>
      {data && (data.length === 0 ? <Empty>Noch keine Lagerplätze. Sie entstehen auch automatisch beim Einlagern.</Empty> : (
        <div className="table-wrap"><table className="compact"><thead><tr><th>Lager</th><th>Platz</th><th className="num">Chargen</th><th className="num">Exemplare</th></tr></thead>
          <tbody>{data.map(l => <tr key={l.id}><td>{l.warehouse}</td><td>{l.code}</td><td className="num">{l.lots}</td><td className="num">{l.units}</td></tr>)}</tbody></table></div>
      ))}
    </>
  );
}

function OpeningStock() {
  const toast = useToast();
  const [p, setP] = useState<{ id: number; name: string; setName: string | null } | null>(null);
  const [f, setF] = useState({ finish: 'nonfoil', condition: 'NM', language: 'en', qty: 1 as number | null, unitCost: null as number | null, loc: '', ownership: 'business', deck: '', acquiredAt: new Date().toISOString().slice(0, 10) });
  const save = async () => {
    if (!p) { toast('Bitte eine Karte wählen.', true); return; }
    try {
      const r = await api.post<Lot>('/api/lots', { productId: p.id, finish: f.finish, condition: f.condition, language: f.language, qty: f.qty, unitCost: f.unitCost,
        locationCode: f.loc || null, ownership: f.ownership, privateDeck: f.deck || null, acquiredAt: f.acquiredAt });
      toast(`Charge ${r.code} angelegt.`); setP(null);
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="card">
      <p className="small">Für Karten, die du schon besitzt (Anfangsbestand) oder die nicht über den Purchase Manager kamen. Privatkarten (z. B. gespielte Decks) hier als „Privat“ erfassen – sie bleiben strikt getrennt und unverkäuflich.</p>
      <div className="row" style={{ marginBottom: 10 }}><ProductSearch onPick={h => setP(h)} />{p && <strong>{p.name} <span className="muted small">{p.setName}</span></strong>}</div>
      <div className="form-grid">
        <label className="field">Bestand<select value={f.ownership} onChange={e => setF({ ...f, ownership: e.target.value })}><option value="business">Handelsbestand</option><option value="private">Privat</option></select></label>
        {f.ownership === 'private' && <label className="field">Deck<input type="text" value={f.deck} onChange={e => setF({ ...f, deck: e.target.value })} /></label>}
        <label className="field">Finish<select value={f.finish} onChange={e => setF({ ...f, finish: e.target.value })}><option value="nonfoil">Nonfoil</option><option value="foil">Foil</option></select></label>
        <label className="field">Zustand<select value={f.condition} onChange={e => setF({ ...f, condition: e.target.value })}>{CONDS.map(c => <option key={c}>{c}</option>)}</select></label>
        <label className="field">Sprache<input type="text" value={f.language} onChange={e => setF({ ...f, language: e.target.value.toLowerCase() })} /></label>
        <label className="field">Menge<NumInput value={f.qty} onChange={v => setF({ ...f, qty: v })} /></label>
        <label className="field">Einstand je Stück €<NumInput value={f.unitCost} onChange={v => setF({ ...f, unitCost: v })} /></label>
        <label className="field">Erworben am<input type="date" value={f.acquiredAt} onChange={e => setF({ ...f, acquiredAt: e.target.value })} /></label>
        <label className="field">Lagerplatz<input type="text" value={f.loc} onChange={e => setF({ ...f, loc: e.target.value.toUpperCase() })} /></label>
      </div>
      <div className="row" style={{ marginTop: 10 }}><button className="btn primary" onClick={save}>Charge anlegen</button></div>
    </div>
  );
}

export function Inventory() {
  const [tab, setTab] = useState<'stock' | 'repricing' | 'locations' | 'private' | 'opening'>('stock');
  return (
    <>
      <div className="page-head"><h1>Inventory</h1><span className="sub">Chargen mit Einstand, Lagerplatz und Verkaufsstatus</span></div>
      <div className="tabs">
        {([['stock', 'Handelsbestand'], ['repricing', 'Repricing'], ['locations', 'Lagerplätze'], ['private', 'Privatbestand'], ['opening', 'Bestand erfassen']] as const).map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'stock' && <StockList ownership="business" />}
      {tab === 'private' && <StockList ownership="private" />}
      {tab === 'repricing' && <Repricing />}
      {tab === 'locations' && <Locations />}
      {tab === 'opening' && <OpeningStock />}
    </>
  );
}
