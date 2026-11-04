import { useState } from 'react';
import { api, type CalcResult, type SearchHit, type TradeResult } from '../api';
import { euro, LANG_LABEL, pct } from '../format';
import { Money, NumInput, useToast } from '../ui';
import { ProductSearch } from './Watchlist';

function Breakdown({ title, r }: { title: string; r: TradeResult }) {
  return (
    <div className="card">
      <div className="card-head"><h2>{title}</h2><span className="spacer" /><strong><Money v={r.profit} signed /></strong></div>
      <table className="compact"><tbody>
        {r.lines.map(l => <tr key={l.key}><td className="wrap">{l.label}{l.note && <div className="small muted">{l.note}</div>}</td><td className="num"><Money v={l.amount} signed /></td></tr>)}
        <tr><td><strong>Deckungsbeitrag</strong></td><td className="num"><strong><Money v={r.profit} signed /></strong></td></tr>
        <tr><td>ROI / Marge</td><td className="num">{pct(r.roiPct)} / {pct(r.marginPct)}</td></tr>
      </tbody></table>
      {r.warnings.map(w => <div key={w} className="notice warn small" style={{ marginTop: 8 }}>{w}</div>)}
    </div>
  );
}

export function Calculator() {
  const toast = useToast();
  const [product, setProduct] = useState<SearchHit | null>(null);
  const [finish, setFinish] = useState<'nonfoil' | 'foil'>('nonfoil');
  const [condition, setCondition] = useState('NM');
  const [language, setLanguage] = useState('en');
  const [country, setCountry] = useState('Deutschland');
  const [buyPrice, setBuyPrice] = useState<number | null>(null);
  const [buyShipping, setBuyShipping] = useState<number | null>(null);
  const [sellPrice, setSellPrice] = useState<number | null>(null);
  const [res, setRes] = useState<CalcResult | null>(null);

  const calc = async () => {
    if (buyPrice == null) { toast('Bitte einen Einkaufspreis eingeben.', true); return; }
    if (!product && sellPrice == null) { toast('Ohne Karte bitte einen Verkaufspreis angeben.', true); return; }
    try {
      setRes(await api.post<CalcResult>('/api/calc', {
        buyPrice, buyShipping, sellPrice, sellerCountry: country,
        ...(product ? { productId: product.id, finish, condition, language } : {}),
      }));
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      <div className="page-head"><h1>Profit-Rechner</h1><span className="sub">Transparente Kalkulation mit deinen Gebühren- und Steuereinstellungen</span></div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <ProductSearch onPick={setProduct} placeholder="Optional: Karte wählen → Verkaufsszenarien aus dem Price Guide" />
          {product && <span>{product.name} <span className="muted small">({product.setName})</span> <button className="btn link small" onClick={() => setProduct(null)}>entfernen</button></span>}
        </div>
        <div className="form-grid">
          {product && <>
            <label className="field">Finish<select value={finish} onChange={e => setFinish(e.target.value as 'nonfoil' | 'foil')}><option value="nonfoil">Nonfoil</option><option value="foil">Foil</option></select></label>
            <label className="field">Zustand<select value={condition} onChange={e => setCondition(e.target.value)}>{['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'].map(c => <option key={c}>{c}</option>)}</select></label>
            <label className="field">Sprache<select value={language} onChange={e => setLanguage(e.target.value)}>{Object.entries(LANG_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          </>}
          <label className="field">Einkaufspreis €<NumInput value={buyPrice} onChange={setBuyPrice} /></label>
          <label className="field">Einkaufsporto € (leer = schätzen)<NumInput value={buyShipping} onChange={setBuyShipping} /></label>
          <label className="field">Land des Verkäufers<input type="text" value={country} onChange={e => setCountry(e.target.value)} /></label>
          <label className="field">Eigener Verkaufspreis € (optional)<NumInput value={sellPrice} onChange={setSellPrice} /></label>
        </div>
        <div className="row" style={{ marginTop: 12 }}><button className="btn primary" onClick={calc}>Berechnen</button></div>
      </div>
      {res && (
        <>
          <div className="tiles">
            <div className="card tile"><div className="label">Einkaufsporto</div><div className="value">{euro(res.buyShipping)}</div><div className="hint">{res.shippingNote}</div></div>
            <div className="card tile"><div className="label">Break-even-Verkaufspreis</div><div className="value">{euro(res.breakEvenSellPrice)}</div></div>
            <div className="card tile"><div className="label">Max. Einkaufspreis</div><div className="value">{euro(res.maxBuyPrice)}</div><div className="hint">für Mindestgewinn + Ziel-ROI ({res.maxBuyPriceBasis ?? '–'})</div></div>
            <div className="card tile"><div className="label">Steuermodus</div><div className="value" style={{ fontSize: 16 }}>{res.taxMode}</div></div>
          </div>
          {res.resale && <div className="notice info small">Verkaufsszenarien aus dem Price Guide: konservativ {euro(res.resale.conservative)}, Basis {euro(res.resale.base)}, optimistisch {euro(res.resale.optimistic)} (nicht garantiert). {res.resale.notes.join(' ')}</div>}
          <div className="grid cols-3">
            {res.scenarios?.conservative && <Breakdown title="Konservativ" r={res.scenarios.conservative} />}
            {res.scenarios?.base && <Breakdown title="Basis" r={res.scenarios.base} />}
            {res.scenarios?.optimistic && <Breakdown title="Optimistisch" r={res.scenarios.optimistic} />}
            {res.manual && <Breakdown title="Eigener Verkaufspreis" r={res.manual} />}
          </div>
        </>
      )}
    </>
  );
}
