import { useState } from 'react';
import { api, type ObservedOffer, type Opportunity } from '../api';
import { useShell } from '../App';
import { age, dateTime, euro } from '../format';
import { Empty, ErrorNotice, Money, Rec, SignalBadge, useAsync, useToast } from '../ui';

interface WatchBundle {
  seller: string; country: string | null; sellerType: string | null; sales: number | null; cards: number; copies: number; subtotal: number;
  shipping: { cost: number; tracked: boolean }; total: number; savings: number | null; stale: boolean; oldestObservation: string;
  items: { key: string; name: string; need: number; copies: number; subtotal: number; condition: string | null; expansion: string | null; observedAt: string; stale: boolean }[];
}
interface DealBundle {
  seller: string; country: string | null; cards: number; subtotal: number; shipping: { cost: number; tracked: boolean }; singleShipping: number; savings: number;
  profitSeparately: number; profitBundled: number; stale: boolean;
  items: { key: string; name: string; setName: string | null; price: number; condition: string | null; observedAt: string; recommendation: string }[];
}

function ObservedList() {
  const { openProduct } = useShell();
  const [sim, setSim] = useState(false);
  const { data, error } = useAsync(() => api.get<ObservedOffer[]>(`/api/offers?limit=500${sim ? '&includeSimulation=1' : ''}`), [sim]);
  const opps = useAsync(() => api.get<{ items: Opportunity[] }>('/api/opportunities?strategy=underpriced_offer&limit=2000'), []);
  const byOffer = new Map((opps.data?.items ?? []).map(o => [o.buy.offerId, o]));
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="check"><input type="checkbox" checked={sim} onChange={e => setSim(e.target.checked)} /> Simulierte Angebote einblenden</label>
        <span className="small muted">Bewertung aus dem letzten Analyse-Lauf; neue Angebote werden nach ca. 20 Sekunden eingerechnet.</span>
      </div>
      <ErrorNotice error={error} />
      {data && (data.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Signal</th><th>Karte</th><th>Edition</th><th className="num">Preis</th><th>Zustand</th><th>Sprache</th><th>Verkäufer</th><th>Beobachtet</th><th>Quelle</th><th className="num">Gewinn (Basis)</th><th>Empfehlung</th><th></th></tr></thead>
          <tbody>{data.map(o => {
            const op = byOffer.get(o.id);
            return (
              <tr key={o.id} className={o.productId ? 'clickable' : ''} onClick={() => o.productId && openProduct(o.productId, op?.key)}>
                <td><SignalBadge c={o.signalClass} /></td>
                <td>{o.productName ?? '?'}{o.finish === 'foil' ? ' (Foil)' : ''}{!o.productId && <span className="neg small"> · nicht zugeordnet</span>}</td>
                <td className="small">{o.expansionName ?? '–'}</td>
                <td className="num">{euro(o.price)}{o.previousPrice != null && <div className="small muted">vorher {euro(o.previousPrice)}</div>}</td>
                <td>{o.condition ?? '?'}</td><td>{o.language ?? '?'}</td>
                <td className="small">{o.seller ?? '–'}{o.sellerCountry ? ` (${o.sellerCountry})` : ''}</td>
                <td className="small" title={dateTime(o.observedAt)}>{age(o.observedAt)}</td>
                <td className="small">{o.source}</td>
                <td className="num">{op ? <Money v={op.scenarios.base?.profit} signed /> : <span className="muted">–</span>}</td>
                <td>{op ? <Rec r={op.recommendation} /> : <span className="muted small">noch nicht bewertet</span>}</td>
                <td>{o.url && <a href={o.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>↗</a>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      ) : <Empty>Noch keine beobachteten Angebote. Die Browser-Erweiterung überträgt Angebote erst nach ausdrücklicher Aktivierung („An Dashboard senden“), oder nutze den manuellen Import.</Empty>)}
    </>
  );
}

const CSV_EXAMPLE = `idProduct;Name;Preis;Zustand;Sprache;Foil;Verkäufer;Land;URL
152;Chrome Mox;62,50;NM;en;nein;Beispielverkäufer;Deutschland;https://www.cardmarket.com/de/Magic/Products/Singles/Mirrodin/Chrome-Mox`;

function ManualImport() {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const submit = async () => {
    try {
      const r = await api.post<{ inserted: number; updated: number; unmatched: number; rejected: { index: number; reason: string }[]; parseErrors: string[] }>('/api/offers/csv', { csv });
      setResult(`${r.inserted} neu, ${r.updated} aktualisiert, ${r.unmatched} keinem Produkt zugeordnet` +
        (r.rejected.length ? `, ${r.rejected.length} abgelehnt (${r.rejected.map(x => x.reason).join('; ')})` : '') +
        (r.parseErrors.length ? ` · Lesefehler: ${r.parseErrors.join('; ')}` : ''));
      toast('Angebote importiert.');
    } catch (e) { setResult(null); toast((e as Error).message, true); }
  };
  return (
    <div className="card">
      <p className="small">Selbst beobachtete Angebote als CSV einfügen (Trennzeichen <code>;</code> oder <code>,</code>, erste Zeile = Spaltennamen). Pflicht: <code>idProduct</code> oder <code>Name</code> sowie <code>Preis</code>.
        Optional: Edition, Zustand (MT/NM/EX/GD/LP/PL/PO), Sprache (en, de, fr …), Foil, Verkäufer, Land, URL, Anzahl, Zeitpunkt.
        Ohne Zeitpunkt gilt „jetzt“ als Beobachtungszeit. Die Angebote werden als <strong>LIVE-ANGEBOT (manuell)</strong> gespeichert – bitte nur tatsächlich gesehene Angebote eintragen.</p>
      <textarea value={csv} onChange={e => setCsv(e.target.value)} placeholder={CSV_EXAMPLE} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={!csv.trim()} onClick={submit}>Importieren</button>
        <button className="btn link" onClick={() => setCsv(CSV_EXAMPLE)}>Beispiel einfügen</button>
        {result && <span className="small">{result}</span>}
      </div>
    </div>
  );
}

function Bundles() {
  const [mode, setMode] = useState<'watchlist' | 'deals'>('watchlist');
  const w = useAsync(() => api.get<{ bundles: WatchBundle[]; activeCount: number; coveredCount: number; missing: { id: number; name: string }[] }>('/api/bundles?mode=watchlist'), []);
  const d = useAsync(() => api.get<{ bundles: DealBundle[] }>('/api/bundles?mode=deals'), []);
  return (
    <>
      <div className="tabs">
        <button className={mode === 'watchlist' ? 'active' : ''} onClick={() => setMode('watchlist')}>Watchlist bündeln</button>
        <button className={mode === 'deals' ? 'active' : ''} onClick={() => setMode('deals')}>Profitable Angebote bündeln</button>
      </div>
      <p className="small muted">Grundlage sind nur beobachtete Angebote. Bestände können sich geändert haben – <strong>vor dem Kauf auf Cardmarket prüfen</strong>. Veraltete Beobachtungen sind markiert.</p>
      {mode === 'watchlist' && w.data && (
        <>
          <p className="small">Angebote bekannt für {w.data.coveredCount} von {w.data.activeCount} offenen Watchlist-Karten.{w.data.missing.length > 0 && ` Noch ohne Angebote: ${w.data.missing.slice(0, 12).map(m => m.name).join(', ')}${w.data.missing.length > 12 ? ' …' : ''}`}</p>
          {w.data.bundles.length === 0 ? <Empty>Kein Verkäufer hat mehrere deiner offenen Karten (mit deinen Filtern).</Empty> : (
            <div className="grid cols-2">{w.data.bundles.slice(0, 20).map(b => (
              <div key={b.seller} className="card">
                <div className="card-head"><h2>{b.seller}</h2><span className="small muted">{b.cards} Karten · {b.country ?? '?'}{b.sales != null ? ` · ${b.sales} Verkäufe` : ''}</span>{b.stale && <span className="badge SIMULATION">veraltet</span>}</div>
                <table className="compact"><tbody>{b.items.map(i => (
                  <tr key={i.key}><td className="wrap">{i.copies}× {i.name}<span className="muted small"> – {i.condition}{i.expansion ? ', ' + i.expansion : ''}{i.copies < i.need ? ` (nur ${i.copies} von ${i.need})` : ''}</span></td><td className="num">{euro(i.subtotal)}</td></tr>
                ))}</tbody></table>
                <div className="small" style={{ marginTop: 6 }}>{euro(b.subtotal)} + {euro(b.shipping.cost)} Porto{b.shipping.tracked ? ' (versichert)' : ''} = <strong>{euro(b.total)}</strong>
                  {b.savings != null && (b.savings > 0.005 ? <span className="pos"> · spart ca. {euro(b.savings)}</span> : <span className="neg"> · lohnt nicht ({euro(-b.savings)} teurer)</span>)}
                  <span className="muted"> · älteste Beobachtung {age(b.oldestObservation)}</span></div>
              </div>
            ))}</div>
          )}
        </>
      )}
      {mode === 'deals' && d.data && (d.data.bundles.length === 0 ? <Empty>Keine Verkäufer mit mehreren profitablen Live-Angeboten.</Empty> : (
        <div className="grid cols-2">{d.data.bundles.map(b => (
          <div key={b.seller} className="card">
            <div className="card-head"><h2>{b.seller}</h2><span className="small muted">{b.cards} Angebote · {b.country ?? '?'}</span>{b.stale && <span className="badge SIMULATION">veraltet</span>}</div>
            <table className="compact"><tbody>{b.items.map(i => (
              <tr key={i.key}><td className="wrap">{i.name}<span className="muted small"> – {i.condition}, {i.setName}</span></td><td className="num">{euro(i.price)}</td><td><Rec r={i.recommendation} /></td></tr>
            ))}</tbody></table>
            <div className="small" style={{ marginTop: 6 }}>Porto gebündelt {euro(b.shipping.cost)} statt {euro(b.singleShipping)} → Ersparnis <span className="pos">{euro(b.savings)}</span>. Gewinn gesamt <strong>{euro(b.profitBundled)}</strong> (einzeln {euro(b.profitSeparately)}).</div>
          </div>
        ))}</div>
      ))}
    </>
  );
}

function Simulation() {
  const toast = useToast();
  const [count, setCount] = useState(40);
  const run = async () => {
    try { const r = await api.post<{ note: string }>('/api/simulation', { count }); toast(r.note); } catch (e) { toast((e as Error).message, true); }
  };
  const clear = async () => {
    try { const r = await api.del<{ deleted: number }>('/api/simulation'); toast(`${r.deleted} simulierte Angebote gelöscht.`); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="card">
      <p className="small">Erzeugt simulierte Einzelangebote für zufällige Karten im erlaubten Preisband (Preis 60–105 % des Trends), um Bewertung, Rangliste und Alarme zu testen.
        Simulierte Angebote sind überall als <span className="badge SIMULATION">◇ SIMULATION</span> markiert, werden nie zur Kaufempfehlung und nie an Telegram/Discord gesendet.</p>
      <div className="row">
        <label className="field">Anzahl<input type="number" min={1} max={500} value={count} onChange={e => setCount(Number(e.target.value))} style={{ width: 90 }} /></label>
        <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={run}>Simulation erzeugen</button>
        <button className="btn danger" style={{ alignSelf: 'flex-end' }} onClick={clear}>Alle simulierten Angebote löschen</button>
      </div>
    </div>
  );
}

export function Offers() {
  const [tab, setTab] = useState<'list' | 'import' | 'bundles' | 'sim'>('list');
  return (
    <>
      <div className="page-head"><h1>Angebote & Bündel</h1><span className="sub">beobachtete Einzelangebote – keine Crawling-Daten</span></div>
      <div className="tabs">
        {([['list', 'Beobachtete Angebote'], ['import', 'Manueller Import'], ['bundles', 'Verkäufer-Bündelung'], ['sim', 'Simulation']] as const).map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'list' && <ObservedList />}
      {tab === 'import' && <ManualImport />}
      {tab === 'bundles' && <Bundles />}
      {tab === 'sim' && <Simulation />}
    </>
  );
}
