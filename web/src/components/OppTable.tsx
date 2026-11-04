import type { Opportunity } from '../api';
import { euro, pct, STRATEGY_LABEL } from '../format';
import { Money, PriorityBadge, Rec, Score, SignalBadge } from '../ui';

export type SortKey = 'score' | 'profit' | 'roi' | 'confidence' | 'discount' | 'price' | 'name';

interface Props {
  items: Opportunity[];
  onOpen: (o: Opportunity) => void;
  sort?: SortKey;
  dir?: 'asc' | 'desc';
  onSort?: (k: SortKey) => void;
  compact?: boolean;
}

/** Haupttabelle: Karte | Edition | Marktpreis | Beobachteter Einkauf | Geschätzter Verkauf | Gewinn | ROI | Risiko | Confidence | Signaltyp */
export function OppTable({ items, onOpen, sort, dir, onSort, compact }: Props) {
  const th = (k: SortKey | null, label: string, num = false) => (
    <th className={(num ? 'num ' : '') + (k && onSort ? 'sortable' : '')} onClick={() => k && onSort?.(k)} aria-sort={k && sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      {label}{k && sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
  return (
    <div className="table-wrap">
      <table className={compact ? 'compact' : ''}>
        <thead>
          <tr>
            {th('name', 'Karte')}
            {!compact && th(null, 'Edition')}
            {th('price', 'Marktpreis', true)}
            {th(null, 'Einkauf', true)}
            {th(null, 'Verkauf (Basis)', true)}
            {th('profit', 'Gewinn', true)}
            {th('roi', 'ROI', true)}
            {!compact && th(null, 'Risiko')}
            {th('confidence', 'Confidence', true)}
            {th('score', 'Score')}
            {th(null, 'Signal')}
            {!compact && th(null, 'Priorität')}
            {!compact && th(null, 'Empfehlung')}
          </tr>
        </thead>
        <tbody>
          {items.map(o => (
            <tr key={o.key} className="clickable" onClick={() => onOpen(o)} title={o.reasons.slice(0, 4).join('\n')}>
              <td>
                <strong>{o.name}</strong>{o.finish === 'foil' && <span className="muted small"> · Foil</span>}
                <div className="small muted">{STRATEGY_LABEL[o.strategy]}{o.buy.condition && o.buy.condition !== 'MIX' ? ` · ${o.buy.condition}` : ''}{o.buy.language ? `/${o.buy.language.toUpperCase()}` : ''}</div>
              </td>
              {!compact && <td className="small">{o.setName ?? '–'}{o.setCode ? <span className="muted"> ({o.setCode}{o.collectorNumber ? ' #' + o.collectorNumber : ''})</span> : null}</td>}
              <td className="num">{euro(o.marketPrice)}</td>
              <td className="num" title={`${o.buy.label}\n${euro(o.buy.price)} + ${euro(o.buy.shipping)} Porto (${o.buy.shippingNote})`}>{euro(o.buy.effective)}</td>
              <td className="num" title={`konservativ ${euro(o.resale.conservative)} · optimistisch ${euro(o.resale.optimistic)}`}>{euro(o.resale.base)}</td>
              <td className="num"><Money v={o.scenarios.base?.profit} signed /></td>
              <td className="num">{pct(o.scenarios.base?.roiPct)}</td>
              {!compact && <td className={`risk-${o.score.riskLevel}`}>{o.score.riskLevel}</td>}
              <td className="num">{Math.round(o.score.confidence)}</td>
              <td><Score v={o.score.score} title={o.score.capped ? 'gedeckelt wegen niedriger Confidence' : undefined} /></td>
              <td><SignalBadge c={o.signalClass} /></td>
              {!compact && <td><PriorityBadge p={o.priority} />{o.holdings && o.holdings.copies + o.holdings.onOrder > 0 && <div className="small muted">{o.holdings.copies} im Lager{o.holdings.onOrder ? ` +${o.holdings.onOrder} bestellt` : ''}</div>}</td>}
              {!compact && <td><Rec r={o.recommendation} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
