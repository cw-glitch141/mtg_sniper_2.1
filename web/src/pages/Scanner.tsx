import { useEffect, useState } from 'react';
import { api, qs, type OppList } from '../api';
import { useShell } from '../App';
import { OppTable, type SortKey } from '../components/OppTable';
import { int } from '../format';
import { Empty, ErrorNotice, NumInput, useAsync, useToast } from '../ui';

interface Filters {
  q: string; signalClass: string; strategy: string; recommendation: string; finish: string; risk: string; priority: string;
  minScore: number | null; minConfidence: number | null; minProfit: number | null; minRoi: number | null;
  minPrice: number | null; maxPrice: number | null; rulesPassed: boolean; sort: SortKey; dir: 'asc' | 'desc';
}
const DEFAULTS: Filters = {
  q: '', signalClass: '', strategy: '', recommendation: '', finish: '', risk: '', priority: '', minScore: null, minConfidence: null,
  minProfit: null, minRoi: null, minPrice: null, maxPrice: null, rulesPassed: false, sort: 'score', dir: 'desc',
};
const PAGE = 100;

interface View { id: number; name: string; config: Partial<Filters> }

export function Scanner() {
  const { openProduct, params } = useShell();
  const toast = useToast();
  const [f, setF] = useState<Filters>(() => ({ ...DEFAULTS, rulesPassed: params.get('rulesPassed') === '1', q: params.get('q') ?? '' }));
  const [q, setQ] = useState(f.q);
  const [offset, setOffset] = useState(0);
  const views = useAsync(() => api.get<View[]>('/api/views'), []);

  useEffect(() => { const t = setTimeout(() => setF(x => ({ ...x, q })), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => setOffset(0), [f]);

  const query = qs({ ...f, limit: PAGE, offset });
  const { data, error, loading } = useAsync(() => api.get<OppList>('/api/opportunities' + query), [query]);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF(x => ({ ...x, [k]: v }));
  const onSort = (k: SortKey) => setF(x => ({ ...x, sort: k, dir: x.sort === k && x.dir === 'desc' ? 'asc' : 'desc' }));

  const saveView = async () => {
    const name = prompt('Name der Ansicht:');
    if (!name) return;
    try { await api.post('/api/views', { name, config: f }); views.reload(); toast('Ansicht gespeichert.'); } catch (e) { toast((e as Error).message, true); }
  };
  const applyView = (id: string) => {
    const v = views.data?.find(x => String(x.id) === id);
    if (v) { setF({ ...DEFAULTS, ...v.config }); setQ(v.config.q ?? ''); }
  };
  const deleteView = async (id: string) => {
    if (!id || !confirm('Ansicht löschen?')) return;
    await api.del(`/api/views/${id}`); views.reload();
  };
  const [selView, setSelView] = useState('');

  return (
    <>
      <div className="page-head">
        <h1>Trading Opportunities</h1>
        <span className="sub">{data ? `${int(data.total)} Möglichkeiten` : ''}</span>
        <div className="actions">
          <select value={selView} onChange={e => { setSelView(e.target.value); applyView(e.target.value); }} aria-label="Gespeicherte Ansicht">
            <option value="">Gespeicherte Ansichten …</option>
            {views.data?.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          {selView && <button className="btn small danger" onClick={() => { void deleteView(selView); setSelView(''); }}>Löschen</button>}
          <button className="btn" onClick={saveView}>Ansicht speichern</button>
          <a className="btn" href={'/api/opportunities.csv' + qs({ ...f })} download>CSV-Export</a>
        </div>
      </div>

      <div className="card filters">
        <label className="field">Suche<input type="search" placeholder="Kartenname" value={q} onChange={e => setQ(e.target.value)} /></label>
        <label className="field">Signaltyp
          <select value={f.signalClass} onChange={e => set('signalClass', e.target.value)}>
            <option value="">alle</option><option value="LIVE_OFFER">Live-Angebot</option><option value="MARKET_SIGNAL">Marktsignal</option><option value="SIMULATION">Simulation</option>
          </select></label>
        <label className="field">Strategie
          <select value={f.strategy} onChange={e => set('strategy', e.target.value)}>
            <option value="">alle</option><option value="underpriced_offer">Einzelangebot</option><option value="price_dip">Price-Dip</option><option value="volatility">Volatilität</option><option value="spread_low">Spread Tiefstpreis</option>
          </select></label>
        <label className="field">Empfehlung
          <select value={f.recommendation} onChange={e => set('recommendation', e.target.value)}>
            <option value="">alle</option><option>KAUFEN</option><option>PRÜFEN</option><option>NICHT KAUFEN</option>
          </select></label>
        <label className="field">Priorität
          <select value={f.priority} onChange={e => set('priority', e.target.value)}>
            <option value="">alle</option><option value="HIGH">HIGH PRIORITY</option><option value="MEDIUM">MEDIUM</option><option value="WATCH">MARKET WATCH</option>
          </select></label>
        <label className="field">Finish
          <select value={f.finish} onChange={e => set('finish', e.target.value)}><option value="">alle</option><option value="nonfoil">Nonfoil</option><option value="foil">Foil</option></select></label>
        <label className="field">Risiko
          <select value={f.risk} onChange={e => set('risk', e.target.value)}><option value="">alle</option><option>niedrig</option><option>mittel</option><option>hoch</option></select></label>
        <label className="field">Score ≥<NumInput value={f.minScore} onChange={v => set('minScore', v)} width={70} /></label>
        <label className="field">Confidence ≥<NumInput value={f.minConfidence} onChange={v => set('minConfidence', v)} width={70} /></label>
        <label className="field">Gewinn ≥ €<NumInput value={f.minProfit} onChange={v => set('minProfit', v)} width={70} /></label>
        <label className="field">ROI ≥ %<NumInput value={f.minRoi} onChange={v => set('minRoi', v)} width={70} /></label>
        <label className="field">Marktpreis €<span className="row"><NumInput value={f.minPrice} onChange={v => set('minPrice', v)} width={60} placeholder="von" /><NumInput value={f.maxPrice} onChange={v => set('maxPrice', v)} width={60} placeholder="bis" /></span></label>
        <label className="check"><input type="checkbox" checked={f.rulesPassed} onChange={e => set('rulesPassed', e.target.checked)} /> nur Kaufregeln erfüllt</label>
        <button className="btn link" onClick={() => { setF(DEFAULTS); setQ(''); setSelView(''); }}>Zurücksetzen</button>
      </div>

      <ErrorNotice error={error} />
      {data && (data.items.length ? <OppTable items={data.items} onOpen={o => openProduct(o.productId, o.key)} sort={f.sort} dir={f.dir} onSort={onSort} /> :
        <Empty>{data.runId == null ? 'Noch keine Analyse – unter „Datenquellen“ einen Import starten.' : 'Keine Treffer für diese Filter.'}</Empty>)}
      {loading && !data && <Empty>Lade …</Empty>}
      {data && data.total > PAGE && (
        <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
          <button className="btn" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - PAGE))}>← zurück</button>
          <span className="muted">{offset + 1}–{Math.min(offset + PAGE, data.total)} von {int(data.total)}</span>
          <button className="btn" disabled={offset + PAGE >= data.total} onClick={() => setOffset(o => o + PAGE)}>weiter →</button>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>
        Zeile anklicken für Kalkulation, Preisdiagramm und Begründung. <strong>Marktsignale</strong> beruhen auf aggregierten Tageswerten des Cardmarket Price Guide und sind keine kaufbaren Angebote.
        <strong> Live-Angebote</strong> wurden tatsächlich beobachtet (Zeitpunkt in der Detailansicht).
      </p>
    </>
  );
}
