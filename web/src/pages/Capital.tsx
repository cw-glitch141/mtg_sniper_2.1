import { useState } from 'react';
import { api, type LedgerEntry, type Portfolio, type PortfolioPoint } from '../api';
import { SeriesChart } from '../components/SeriesChart';
import { date, euro, int, pct } from '../format';
import { Empty, ErrorNotice, Money, NumInput, useAsync, useToast } from '../ui';

const LEDGER_LABEL: Record<string, string> = { deposit: 'Einlage', withdrawal: 'Entnahme', expense: 'Laufende Kosten', tax_payment: 'Steuerzahlung', adjustment: 'Korrektur' };

function Ledger({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const { data, reload } = useAsync(() => api.get<LedgerEntry[]>('/api/ledger'), []);
  const [type, setType] = useState('deposit');
  const [amount, setAmount] = useState<number | null>(null);
  const [bookedAt, setBookedAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const add = async () => {
    try { await api.post('/api/ledger', { type, amount, bookedAt, note: note || null }); setAmount(null); setNote(''); reload(); onChanged(); toast('Gebucht.'); }
    catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="card">
      <div className="card-head"><h2>Kapitalbuch</h2><span className="small muted">Einlagen, Entnahmen, laufende Kosten (Hüllen, Versandmaterial, Abos …), Steuerzahlungen</span></div>
      <div className="filters">
        <label className="field">Art<select value={type} onChange={e => setType(e.target.value)}>{Object.entries(LEDGER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field">Betrag €<NumInput value={amount} onChange={setAmount} /></label>
        <label className="field">Datum<input type="date" value={bookedAt} onChange={e => setBookedAt(e.target.value)} /></label>
        <label className="field">Notiz<input type="text" value={note} onChange={e => setNote(e.target.value)} /></label>
        <button className="btn primary" onClick={add}>Buchen</button>
      </div>
      {data && (data.length === 0 ? <Empty>Noch keine Buchungen. Beginne mit der Einlage deines Handelskapitals.</Empty> : (
        <table className="compact"><tbody>{data.map(e => (
          <tr key={e.id}><td>{date(e.bookedAt)}</td><td>{LEDGER_LABEL[e.type] ?? e.type}</td><td className="num"><Money v={['deposit'].includes(e.type) ? e.amount : e.type === 'adjustment' ? e.amount : -e.amount} signed /></td>
            <td className="small muted wrap">{e.note ?? ''}</td><td><button className="btn small danger" onClick={async () => { if (confirm('Buchung löschen?')) { await api.del(`/api/ledger/${e.id}`); reload(); onChanged(); } }}>✕</button></td></tr>
        ))}</tbody></table>
      ))}
    </div>
  );
}

export function Capital() {
  const { data, error, reload } = useAsync(() => api.get<Portfolio>('/api/portfolio'), []);
  const hist = useAsync(() => api.get<PortfolioPoint[]>('/api/portfolio/history'), []);
  const o = data?.overview;
  const L = data?.limits;
  return (
    <>
      <div className="page-head"><h1>Capital & Risk</h1><span className="sub">Alle Werte ohne Privatbestand · Kasse aus Belegen abgeleitet</span></div>
      <ErrorNotice error={error} />
      {o && L && (
        <>
          {o.warnings.length > 0 && <div className="notice warn"><ul>{o.warnings.map(w => <li key={w}>{w}</li>)}</ul></div>}
          <div className="tiles">
            <div className="card tile"><div className="label">Handelskapital gesamt</div><div className="value">{euro(o.totalTradingCapital)}</div><div className="hint">Kasse + Lager + unterwegs + Forderungen</div></div>
            <div className="card tile"><div className="label">Verfügbares Kapital</div><div className="value"><Money v={o.availableCapital} signed /></div><div className="hint">nach Reserve {euro(o.liquidityReserve)}</div></div>
            <div className="card tile"><div className="label">Kasse</div><div className="value">{euro(o.cash)}</div></div>
            <div className="card tile"><div className="label">Reserviert für Einkäufe</div><div className="value">{euro(o.reservedForPurchases)}</div><div className="hint">geplant/bestellt, unbezahlt</div></div>
            <div className="card tile"><div className="label">Eingesetzt im Lager</div><div className="value">{euro(o.investedInStock)}</div><div className="hint">+ unterwegs {euro(o.inTransit)}</div></div>
            <div className="card tile"><div className="label">Unverkaufte Ware</div><div className="value">{int(o.unsold.units)} Stk</div><div className="hint">Einstand {euro(o.unsold.cost)} · reserviert {int(o.reserved.units)}</div></div>
            <div className="card tile kpi-forecast"><div className="label">Erwartete Erlöse</div><div className="value">{euro(o.expectedProceeds.value)}</div><div className="hint">{o.expectedProceeds.unvaluedUnits ? `${o.expectedProceeds.unvaluedUnits} Stk ohne Wert` : 'Angebotspreis / Marktwert'}</div></div>
            <div className="card tile"><div className="label">Realisierte Erlöse</div><div className="value">{euro(o.realizedRevenue)}</div><div className="hint">DB {euro(o.realizedContribution)}</div></div>
            <div className="card tile"><div className="label">Forderungen</div><div className="value">{euro(o.receivables)}</div><div className="hint">versendet, Zahlung offen</div></div>
            <div className="card tile"><div className="label">Offene Verpflichtungen</div><div className="value">{euro(o.openObligations)}</div><div className="hint">inkl. USt-Schätzung {euro(o.vatLiabilityEstimate)}</div></div>
          </div>
          <div className="grid cols-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-head"><h2>Limits</h2><a className="more" href="#/settings">ändern →</a></div>
              <dl className="kv">
                <dt>Max. Kaufbetrag je Karte</dt><dd>{euro(L.maxCapitalPerCard)}</dd>
                <dt>Max. Gesamtbestand</dt><dd>{euro(L.maxInventoryCapital)} (derzeit {euro(o.investedInStock + o.inTransit + o.reservedForPurchases)})</dd>
                <dt>Max. identische Exemplare</dt><dd>{L.maxCopiesPerCard}</dd>
                <dt>Max. Investition je Edition</dt><dd>{euro(L.maxInvestmentPerSet)}</dd>
                <dt>Langsamdreher-Anteil</dt><dd>{pct(o.slowMoverSharePct)} von max. {L.maxSlowMoverSharePct} % (ab {L.slowMoverDays} Tagen)</dd>
                <dt>Mindestreserve</dt><dd>{euro(L.minLiquidityReserve)}</dd>
              </dl>
              <p className="small muted">Die Limits fließen als Kaufregeln in jede Empfehlung ein: Bei erreichten Grenzen wird nichts mehr zum Kauf empfohlen.</p>
            </div>
            <div className="card">
              <div className="card-head"><h2>Bestandswert</h2><span className="small muted">Einstand vs. geschätzter Marktwert (Prognose)</span></div>
              <SeriesChart data={hist.data ?? []} x="date" kind="line" series={[{ key: 'costValue', label: 'Einstand' }, { key: 'marketValue', label: 'Marktwert (Schätzung)' }]} empty="Entsteht mit jedem täglichen Analyse-Lauf." />
            </div>
          </div>
          <div className="grid cols-2" style={{ marginBottom: 16 }}>
            <div className="card"><div className="card-head"><h2>Konzentration nach Edition</h2></div>
              {data.concentration.bySet.length ? <table className="compact"><tbody>{data.concentration.bySet.map(r => (
                <tr key={r.setName ?? '-'}><td>{r.setName ?? 'unbekannt'}</td><td className="num">{r.units} Stk</td><td className={`num ${r.overLimit ? 'neg' : ''}`}>{euro(r.cost)}{r.overLimit ? ' ⚠' : ''}</td></tr>))}</tbody></table> : <Empty>Kein Bestand.</Empty>}
            </div>
            <div className="card"><div className="card-head"><h2>Konzentration nach Karte</h2></div>
              {data.concentration.byCard.length ? <table className="compact"><tbody>{data.concentration.byCard.map(r => (
                <tr key={`${r.productId}-${r.name}-${r.finish}`}><td>{r.name}{r.finish === 'foil' ? ' (Foil)' : ''}</td><td className={`num ${r.overLimit ? 'neg' : ''}`}>{r.units} Stk{r.overLimit ? ' ⚠' : ''}</td><td className="num">{euro(r.cost)}</td></tr>))}</tbody></table> : <Empty>Kein Bestand.</Empty>}
            </div>
          </div>
          <Ledger onChanged={reload} />
        </>
      )}
    </>
  );
}
