import { useEffect, useState } from 'react';
import { api, type SearchHit, type WatchEntry } from '../api';
import { useShell } from '../App';
import { euro } from '../format';
import { Empty, ErrorNotice, NumInput, useAsync, useToast } from '../ui';

export function ProductSearch({ onPick, placeholder = 'Karte suchen (Name, Set-Code oder Cardmarket-ID)' }: { onPick: (h: SearchHit) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => { api.get<SearchHit[]>(`/api/products/search?q=${encodeURIComponent(q)}&limit=15`).then(setHits).catch(() => setHits([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 260 }}>
      <input type="search" style={{ width: '100%' }} placeholder={placeholder} value={q} onChange={e => setQ(e.target.value)} />
      {hits.length > 0 && (
        <div className="card" style={{ position: 'absolute', zIndex: 10, left: 0, right: 0, top: '110%', padding: 4, maxHeight: 340, overflowY: 'auto' }}>
          {hits.map(h => (
            <div key={h.id} className="row clickable" style={{ padding: '5px 8px', cursor: 'pointer', borderRadius: 4 }}
              onMouseDown={e => { e.preventDefault(); onPick(h); setQ(''); setHits([]); }}>
              <span>{h.name}</span><span className="muted small">{h.setName ?? '?'}{h.setCode ? ` (${h.setCode} #${h.collectorNumber ?? '?'})` : ''}</span>
              <span className="spacer" /><span className="small tabnum">{euro(h.trend)}{h.trendFoil ? ` · Foil ${euro(h.trendFoil)}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Watchlist() {
  const toast = useToast();
  const { openProduct } = useShell();
  const [list, setList] = useState('');
  const lists = useAsync(() => api.get<{ name: string; entries: number }[]>('/api/watchlist/lists'), []);
  const { data, error, reload } = useAsync(() => api.get<WatchEntry[]>('/api/watchlist' + (list ? `?list=${encodeURIComponent(list)}` : '')), [list]);
  const [freeName, setFreeName] = useState('');

  const add = async (body: Record<string, unknown>) => {
    try { await api.post('/api/watchlist', { ...body, listName: list || 'Standard' }); reload(); lists.reload(); toast('Hinzugefügt.'); } catch (e) { toast((e as Error).message, true); }
  };
  const patch = async (id: number, body: Record<string, unknown>) => {
    try { await api.patch(`/api/watchlist/${id}`, body); reload(); } catch (e) { toast((e as Error).message, true); }
  };
  const remove = async (id: number) => {
    try { await api.del(`/api/watchlist/${id}`); reload(); lists.reload(); } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      <div className="page-head">
        <h1>Watchlist</h1>
        <span className="sub">Zielpreise lösen Alarme aus – als LIVE-ANGEBOT (beobachtetes Angebot) oder MARKTSIGNAL (gemeldeter Tiefstpreis)</span>
        <div className="actions">
          <select value={list} onChange={e => setList(e.target.value)} aria-label="Liste">
            <option value="">Alle Listen</option>
            {lists.data?.map(l => <option key={l.name} value={l.name}>{l.name} ({l.entries})</option>)}
          </select>
          <button className="btn" onClick={() => { const n = prompt('Name der neuen Liste:'); if (n) setList(n.trim()); }}>Neue Liste</button>
        </div>
      </div>
      <div className="card row" style={{ marginBottom: 12 }}>
        <ProductSearch onPick={h => add({ productId: h.id })} placeholder="Bestimmten Druck hinzufügen (Suche)" />
        <span className="muted small">oder</span>
        <input type="text" placeholder="Kartenname (alle Drucke)" value={freeName} onChange={e => setFreeName(e.target.value)} />
        <button className="btn" disabled={!freeName.trim()} onClick={() => { void add({ name: freeName.trim() }); setFreeName(''); }}>Hinzufügen</button>
      </div>
      <ErrorNotice error={error} />
      {data && (data.length === 0 ? <Empty>Keine Einträge. Tipp: In der Browser-Erweiterung unter „Dashboard“ die bisherige Watchlist übertragen.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Gekauft</th><th>Karte</th><th>Bezug</th><th className="num">Anzahl</th><th className="num">Zielpreis (inkl. Porto)</th><th title="leer = globale Kaufregel">Mind.-Zustand</th><th title="Kürzel, Komma-getrennt; leer = globale Kaufregel">Sprachen</th><th>Liste</th><th>Herkunft</th><th></th></tr></thead>
          <tbody>{data.map(w => (
            <tr key={w.id} style={{ opacity: w.bought ? 0.55 : 1 }}>
              <td><input type="checkbox" checked={w.bought} onChange={e => patch(w.id, { bought: e.target.checked })} aria-label="gekauft" /></td>
              <td>{w.productId ? <button className="btn link" onClick={() => openProduct(w.productId as number)}>{w.name}</button> : w.name}</td>
              <td className="small muted">{w.productId ? `bestimmter Druck${w.finish ? ' · ' + w.finish : ''}` : 'alle Drucke (Name)'}</td>
              <td className="num"><input type="number" min={1} max={999} value={w.qty} style={{ width: 64 }} onChange={e => { const v = Number(e.target.value); if (v >= 1) void patch(w.id, { qty: v }); }} /></td>
              <td className="num"><NumInput value={w.targetPrice} onChange={v => patch(w.id, { targetPrice: v })} placeholder="–" width={90} /></td>
              <td><select value={w.minCondition ?? ''} onChange={e => patch(w.id, { minCondition: e.target.value || null })} aria-label="Mindestzustand">
                <option value="">global</option>{['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'].map(c => <option key={c} value={c}>{c}</option>)}</select></td>
              <td><input type="text" defaultValue={(w.languages ?? []).join(', ')} placeholder="global" style={{ width: 80 }} aria-label="Sprachen"
                onBlur={e => { const v = e.target.value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean); if (v.join(',') !== (w.languages ?? []).join(',')) void patch(w.id, { languages: v.length ? v : null }); }} /></td>
              <td className="small">{w.listName}</td>
              <td className="small muted">{w.origin}</td>
              <td><button className="btn small danger" onClick={() => remove(w.id)} aria-label="Entfernen">✕</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
    </>
  );
}
