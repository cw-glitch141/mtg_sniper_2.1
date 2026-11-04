import { useState } from 'react';
import { api } from '../api';
import { useShell } from '../App';
import { age, dateTime, int } from '../format';
import { useAsync, useToast } from '../ui';

interface Run { id: number; source: string; started_at: string; finished_at: string | null; status: string; rows_total: number | null; rows_written: number | null; source_created_at: string | null; message: string | null }

const SOURCE_INFO: Record<string, { url: string; text: string }> = {
  cardmarket_price_guide: { url: 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json', text: 'Täglich (nachts) erzeugte Aggregate je Produkt: Trend, Ø 1/7/30 Tage, Tiefstpreis, jeweils Nonfoil/Foil. Keine Einzelangebote, nicht nach Zustand/Sprache getrennt.' },
  cardmarket_catalog: { url: 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_1.json', text: 'Alle Magic-Einzelkarten mit stabiler Produkt-ID (idProduct), Edition-ID und Metacard-ID.' },
  scryfall: { url: 'https://scryfall.com/docs/api/bulk-data', text: 'Zuordnung über cardmarket_id: Set-Code, Collector Number, Seltenheit, Bild. Wird standardmäßig wöchentlich geladen.' },
};

export function DataSources() {
  const toast = useToast();
  const { status, refreshStatus } = useShell();
  const runs = useAsync(() => api.get<Run[]>('/api/import-runs?limit=40'), []);
  const [busy, setBusy] = useState(false);
  const run = async (source: string, force = false) => {
    setBusy(true);
    try {
      const r = await api.post<{ imports: { source: string; status: string; message: string }[] }>('/api/import', { source, force });
      toast(r.imports.map(i => `${i.source}: ${i.status} – ${i.message}`).join(' | '), r.imports.some(i => i.status === 'failed'));
    } catch (e) { toast((e as Error).message, true); }
    setBusy(false); runs.reload(); refreshStatus();
  };
  const analyze = async () => {
    setBusy(true);
    try { await api.post('/api/analyze'); toast('Analyse abgeschlossen.'); } catch (e) { toast((e as Error).message, true); }
    setBusy(false); refreshStatus();
  };

  return (
    <>
      <div className="page-head">
        <h1>Datenquellen</h1>
        <div className="actions">
          <button className="btn primary" disabled={busy} onClick={() => run('all')}>{busy ? 'Läuft …' : 'Jetzt aktualisieren'}</button>
          <button className="btn" disabled={busy} onClick={analyze}>Nur neu analysieren</button>
        </div>
      </div>
      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        {status?.sources.map(s => (
          <div key={s.source} className="card">
            <div className="card-head"><span className={`dot ${s.failing ? 'fail' : s.stale ? 'stale' : 'ok'}`} /><h2>{s.label}</h2></div>
            <dl className="kv">
              <dt>Datenstand</dt><dd>{dateTime(s.dataCreatedAt)}</dd>
              <dt>Letzter Erfolg</dt><dd>{s.lastSuccessAt ? `${dateTime(s.lastSuccessAt)} (${age(s.lastSuccessAt)})` : 'noch nie'}</dd>
              <dt>Letzter Lauf</dt><dd className="small">{s.lastRun ? `${s.lastRun.status} – ${s.lastRun.message ?? ''}` : '–'}</dd>
            </dl>
            <p className="small muted">{SOURCE_INFO[s.source]?.text} <a href={SOURCE_INFO[s.source]?.url} target="_blank" rel="noopener noreferrer">Quelle ↗</a></p>
            <div className="row">
              <button className="btn small" disabled={busy} onClick={() => run(s.source === 'cardmarket_price_guide' ? 'prices' : s.source === 'cardmarket_catalog' ? 'catalog' : 'scryfall')}>Importieren</button>
              {s.source !== 'scryfall' && <button className="btn small" disabled={busy} onClick={() => run(s.source === 'cardmarket_price_guide' ? 'prices' : 'catalog', true)} title="Auch bei unverändertem Datenstand neu einlesen">erzwingen</button>}
            </div>
          </div>
        ))}
      </div>
      {status && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>Datenbestand</h2></div>
          <dl className="kv">
            <dt>Produkte</dt><dd>{int(status.counts.products)} (davon {int(status.counts.mapped)} über Scryfall eindeutig zugeordnet)</dd>
            <dt>Preisreihen</dt><dd>{int(status.counts.priceSeries)}</dd>
            <dt>Eigene Historie</dt><dd>{int(status.counts.historyDays)} Tag(e), {int(status.counts.snapshots)} Snapshots – entsteht ausschließlich durch die täglichen Importe, nichts wird rückwirkend ergänzt.</dd>
            <dt>Live-Angebote</dt><dd>{int(status.counts.liveOffers)} (+ {int(status.counts.simulatedOffers)} simuliert)</dd>
            <dt>Live-Angebotsfeed</dt><dd>{status.liveOfferProviders.length ? status.liveOfferProviders.join(', ') : 'keiner angebunden (keine Cardmarket-API-Zulassung) – Angebote nur über Erweiterung/Import'}</dd>
            <dt>Zeitplan</dt><dd>{status.scheduler?.running ? `aktiv, letzte Prüfung ${age(status.scheduler.lastTickAt)}` : 'aus'}{status.scheduler?.lastError ? ` · Fehler: ${status.scheduler.lastError}` : ''}</dd>
            <dt>Letzte Analyse</dt><dd>{status.analysis ? `${dateTime(status.analysis.finished_at)}: ${int(status.analysis.candidates)} Kandidaten, ${int(status.analysis.opportunities)} Möglichkeiten. ${status.analysis.message ?? ''}` : '–'}</dd>
          </dl>
        </div>
      )}
      <div className="card">
        <div className="card-head"><h2>Import-Protokoll</h2></div>
        <div className="table-wrap"><table className="compact">
          <thead><tr><th>Start</th><th>Quelle</th><th>Status</th><th className="num">Zeilen</th><th className="num">geschrieben</th><th>Datenstand</th><th>Meldung</th></tr></thead>
          <tbody>{runs.data?.map(r => (
            <tr key={r.id}><td>{dateTime(r.started_at)}</td><td>{r.source}</td><td className={r.status === 'failed' ? 'neg' : r.status === 'success' ? 'pos' : 'muted'}>{r.status}</td>
              <td className="num">{int(r.rows_total)}</td><td className="num">{int(r.rows_written)}</td><td>{dateTime(r.source_created_at)}</td><td className="small wrap">{r.message}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
    </>
  );
}
