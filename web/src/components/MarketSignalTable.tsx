import type { Opportunity } from '../api';
import { dateTime, euro, pct, STRATEGY_LABEL } from '../format';
import { ExtraLabels } from '../ui';

/**
 * Market Watch / Recherche: nur Referenzwerte und Trendunterschiede aus dem Price Guide.
 * Bewusst KEIN Einkaufspreis und KEIN Gewinn – zu diesen Werten ist kein Angebot belegt.
 */
export function MarketSignalTable({ items, onOpen }: { items: Opportunity[]; onOpen: (o: Opportunity) => void }) {
  return (
    <div className="table-wrap">
      <table className="compact">
        <thead>
          <tr>
            <th>Karte</th><th>Signal</th>
            <th className="num">Trend</th><th className="num">1-Tages-Ø</th><th className="num">7-Tages-Ø</th><th className="num">30-Tages-Ø</th>
            <th className="num" title="Laut Price Guide zum Erstellungszeitpunkt – Zustand, Sprache und Verfügbarkeit unbekannt">Tiefstpreis (gemeldet)</th>
            <th className="num">1T vs. 30T</th>
            <th className="num" title="Hypothetischer Modellwert der Strategie – kein Angebot zu diesem Preis belegt">Modellwert (hypoth.)</th>
            <th className="num">Datenlage</th><th>Datenstand</th>
          </tr>
        </thead>
        <tbody>
          {items.map(o => (
            <tr key={o.key} className="clickable" onClick={() => onOpen(o)} title={o.reasons.slice(0, 4).join('\n')}>
              <td className="wrap"><strong>{o.name}</strong>{o.finish === 'foil' && <span className="muted small"> · Foil</span>}<div className="small muted">{o.setName ?? ''}</div></td>
              <td className="small">{STRATEGY_LABEL[o.strategy]} <ExtraLabels labels={o.labels} /></td>
              <td className="num">{euro(o.guide?.trend)}</td>
              <td className="num">{euro(o.guide?.avg1)}</td>
              <td className="num">{euro(o.guide?.avg7)}</td>
              <td className="num">{euro(o.guide?.avg30)}</td>
              <td className="num">{euro(o.guide?.low)}</td>
              <td className={`num ${(o.guide?.avg1VsAvg30Pct ?? 0) < 0 ? 'neg' : 'pos'}`}>{pct(o.guide?.avg1VsAvg30Pct, true)}</td>
              <td className="num muted">{euro(o.buy.price)}</td>
              <td className="num" title="Confidence der Statistik, nicht eines Angebots">{Math.round(o.score.confidence)}</td>
              <td className="small">{dateTime(o.dataDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
