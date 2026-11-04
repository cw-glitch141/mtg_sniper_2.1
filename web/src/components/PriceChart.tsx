/**
 * Preisverlauf aus den EIGENEN täglichen Snapshots. Bei zu wenigen Punkten wird das offen gesagt –
 * es wird nichts interpoliert oder ergänzt. Eine Achse, dünne Linien, Crosshair + Tooltip, Tabellenansicht.
 */
import { useMemo, useState } from 'react';
import type { SnapshotPoint } from '../api';
import { date, euro } from '../format';

const SERIES = [
  { key: 'trend', label: 'Trend', color: 'var(--series-1)' },
  { key: 'avg30', label: '30-Tages-Ø', color: 'var(--series-2)' },
  { key: 'low', label: 'Tiefstpreis', color: 'var(--series-3)' },
] as const;

type Key = typeof SERIES[number]['key'];

export function PriceChart({ data }: { data: SnapshotPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [visible, setVisible] = useState<Record<Key, boolean>>({ trend: true, avg30: true, low: false });

  const W = 760, H = 240, P = { l: 56, r: 76, t: 10, b: 26 };
  const geo = useMemo(() => {
    const vals = data.flatMap(d => SERIES.filter(s => visible[s.key]).map(s => d[s.key])).filter((v): v is number => v != null);
    if (!vals.length) return null;
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min *= 0.95; max *= 1.05; }
    const pad = (max - min) * 0.08;
    min = Math.max(0, min - pad); max += pad;
    const t0 = Date.parse(data[0].date), t1 = Date.parse(data[data.length - 1].date);
    const x = (d: string) => P.l + (t1 === t0 ? (W - P.l - P.r) / 2 : (Date.parse(d) - t0) / (t1 - t0) * (W - P.l - P.r));
    const y = (v: number) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
    const ticks = Array.from({ length: 5 }, (_, i) => min + (max - min) * i / 4);
    return { x, y, ticks };
  }, [data, visible]);

  if (data.length === 0) return <div className="empty">Noch keine eigene Preishistorie für diese Variante.</div>;

  const last = data[data.length - 1];
  return (
    <div className="chart">
      <div className="legend">
        {SERIES.map(s => (
          <label key={s.key} className="check">
            <input type="checkbox" checked={visible[s.key]} onChange={e => setVisible(v => ({ ...v, [s.key]: e.target.checked }))} />
            <span><i style={{ background: s.color }} />{s.label}</span>
          </label>
        ))}
        <span className="spacer" />
        <button className="btn link small" onClick={() => setAsTable(t => !t)}>{asTable ? 'Diagramm' : 'Tabelle'}</button>
      </div>
      {data.length < 2 && <div className="small muted" style={{ marginBottom: 6 }}>Erst {data.length} Snapshot – die Zeitreihe wächst mit jedem täglichen Import.</div>}
      {asTable || !geo ? (
        <div className="table-wrap" style={{ maxHeight: 260 }}>
          <table className="compact">
            <thead><tr><th>Datum</th><th className="num">Trend</th><th className="num">1-T-Ø</th><th className="num">7-T-Ø</th><th className="num">30-T-Ø</th><th className="num">Tiefst</th></tr></thead>
            <tbody>{[...data].reverse().map(d => (
              <tr key={d.date}><td>{date(d.date)}</td><td className="num">{euro(d.trend)}</td><td className="num">{euro(d.avg1)}</td><td className="num">{euro(d.avg7)}</td><td className="num">{euro(d.avg30)}</td><td className="num">{euro(d.low)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Preisverlauf"
          onMouseLeave={() => setHover(null)}
          onMouseMove={e => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = (e.clientX - r.left) / r.width * W;
            let best = 0, bd = Infinity;
            data.forEach((d, i) => { const dd = Math.abs(geo.x(d.date) - px); if (dd < bd) { bd = dd; best = i; } });
            setHover(best);
          }}>
          {geo.ticks.map((t, i) => (
            <g key={i}>
              <line x1={P.l} x2={W - P.r} y1={geo.y(t)} y2={geo.y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={P.l - 8} y={geo.y(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)" className="tabnum">{euro(t)}</text>
            </g>
          ))}
          <line x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} stroke="var(--axis)" />
          <text x={P.l} y={H - 6} fontSize={11} fill="var(--text-muted)">{date(data[0].date)}</text>
          <text x={W - P.r} y={H - 6} fontSize={11} fill="var(--text-muted)" textAnchor="end">{date(last.date)}</text>
          {SERIES.filter(s => visible[s.key]).map(s => {
            const pts = data.filter(d => d[s.key] != null);
            const path = pts.map((d, i) => `${i ? 'L' : 'M'}${geo.x(d.date).toFixed(1)},${geo.y(d[s.key] as number).toFixed(1)}`).join('');
            const end = pts[pts.length - 1];
            return (
              <g key={s.key}>
                <path d={path} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {pts.length <= 2 && pts.map(d => <circle key={d.date} cx={geo.x(d.date)} cy={geo.y(d[s.key] as number)} r={4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />)}
                {end && <text x={geo.x(end.date) + 8} y={geo.y(end[s.key] as number) + 4} fontSize={11} fill="var(--text-secondary)">{s.label}</text>}
              </g>
            );
          })}
          {hover != null && (
            <g>
              <line x1={geo.x(data[hover].date)} x2={geo.x(data[hover].date)} y1={P.t} y2={H - P.b} stroke="var(--text-muted)" strokeDasharray="3 3" />
              {SERIES.filter(s => visible[s.key] && data[hover][s.key] != null).map(s => (
                <circle key={s.key} cx={geo.x(data[hover].date)} cy={geo.y(data[hover][s.key] as number)} r={4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hover != null && geo && !asTable && (
        <div className="tooltip" style={{ left: `${geo.x(data[hover].date) / W * 100}%`, top: 24 }}>
          <strong>{date(data[hover].date)}</strong>
          {SERIES.filter(s => visible[s.key]).map(s => <div key={s.key}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />{s.label}: {euro(data[hover][s.key])}</div>)}
        </div>
      )}
    </div>
  );
}
