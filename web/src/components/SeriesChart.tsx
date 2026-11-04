/**
 * Kleines Diagramm für Zeitreihen (Linien) oder Monatswerte (Balken), eine Achse, max. 3 Serien.
 * Legende immer sichtbar, Tooltip beim Überfahren, Tabellenansicht umschaltbar.
 */
import { useMemo, useState } from 'react';
import { euro } from '../format';

export interface Series { key: string; label: string; color: string }

const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function SeriesChart<T extends Record<string, any>>({ data, x, series, kind, format = euro, empty }: {
  data: T[]; x: keyof T & string; series: { key: keyof T & string; label: string }[]; kind: 'line' | 'bar'; format?: (v: number | null) => string; empty: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const S: Series[] = series.map((s, i) => ({ ...s, color: COLORS[i] }));
  const W = 760, H = 220, P = { l: 64, r: 16, t: 10, b: 26 };
  const geo = useMemo(() => {
    const vals = data.flatMap(d => S.map(s => d[s.key] as number | null)).filter((v): v is number => typeof v === 'number');
    if (!vals.length) return null;
    let min = Math.min(0, ...vals), max = Math.max(0, ...vals);
    if (min === max) max = min + 1;
    const pad = (max - min) * 0.08; max += pad; if (min < 0) min -= pad;
    const n = data.length;
    const step = (W - P.l - P.r) / Math.max(1, kind === 'bar' ? n : n - 1);
    const xPos = (i: number) => (kind === 'bar' ? P.l + step * i + step / 2 : P.l + (n === 1 ? (W - P.l - P.r) / 2 : step * i));
    const y = (v: number) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
    return { xPos, y, step, ticks: Array.from({ length: 5 }, (_, i) => min + (max - min) * i / 4) };
  }, [data, kind, S]);

  if (!data.length) return <div className="empty">{empty}</div>;
  return (
    <div className="chart">
      <div className="legend">
        {S.map(s => <span key={s.key}><i style={{ background: s.color, height: kind === 'bar' ? 8 : 2 }} />{s.label}</span>)}
        <span className="spacer" />
        <button className="btn link small" onClick={() => setAsTable(t => !t)}>{asTable ? 'Diagramm' : 'Tabelle'}</button>
      </div>
      {asTable || !geo ? (
        <div className="table-wrap" style={{ maxHeight: 260 }}>
          <table className="compact"><thead><tr><th>{x}</th>{S.map(s => <th key={s.key} className="num">{s.label}</th>)}</tr></thead>
            <tbody>{data.map((d, i) => <tr key={i}><td>{String(d[x])}</td>{S.map(s => <td key={s.key} className="num">{format(d[s.key] as number | null)}</td>)}</tr>)}</tbody></table>
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={S.map(s => s.label).join(', ')} onMouseLeave={() => setHover(null)}
          onMouseMove={e => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = (e.clientX - r.left) / r.width * W;
            let best = 0, bd = Infinity;
            data.forEach((_, i) => { const d = Math.abs(geo.xPos(i) - px); if (d < bd) { bd = d; best = i; } });
            setHover(best);
          }}>
          {geo.ticks.map((t, i) => (
            <g key={i}>
              <line x1={P.l} x2={W - P.r} y1={geo.y(t)} y2={geo.y(t)} stroke={Math.abs(t) < 1e-9 ? 'var(--axis)' : 'var(--grid)'} />
              <text x={P.l - 8} y={geo.y(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)">{format(t)}</text>
            </g>
          ))}
          {data.map((d, i) => (i === 0 || i === data.length - 1 || data.length <= 12) && (
            <text key={i} x={geo.xPos(i)} y={H - 6} fontSize={11} fill="var(--text-muted)" textAnchor="middle">{String(d[x])}</text>
          ))}
          {kind === 'bar' && data.map((d, i) => {
            const bw = Math.min(28, (geo.step - 6) / S.length);
            return S.map((s, k) => {
              const v = d[s.key] as number | null;
              if (v == null) return null;
              const x0 = geo.xPos(i) - (bw * S.length) / 2 + k * bw + 1;
              const y0 = geo.y(Math.max(0, v)), h = Math.abs(geo.y(v) - geo.y(0));
              return <rect key={s.key + i} x={x0} y={y0} width={bw - 2} height={Math.max(1, h)} rx={3} fill={s.color} />;
            });
          })}
          {kind === 'line' && S.map(s => {
            const pts = data.map((d, i) => ({ i, v: d[s.key] as number | null })).filter(p => p.v != null) as { i: number; v: number }[];
            return (
              <g key={s.key}>
                <path d={pts.map((p, j) => `${j ? 'L' : 'M'}${geo.xPos(p.i).toFixed(1)},${geo.y(p.v).toFixed(1)}`).join('')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
                {pts.length <= 2 && pts.map(p => <circle key={p.i} cx={geo.xPos(p.i)} cy={geo.y(p.v)} r={4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />)}
              </g>
            );
          })}
          {hover != null && <line x1={geo.xPos(hover)} x2={geo.xPos(hover)} y1={P.t} y2={H - P.b} stroke="var(--text-muted)" strokeDasharray="3 3" />}
        </svg>
      )}
      {hover != null && geo && !asTable && (
        <div className="tooltip" style={{ left: `${geo.xPos(hover) / W * 100}%`, top: 24 }}>
          <strong>{String(data[hover][x])}</strong>
          {S.map(s => <div key={s.key}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />{s.label}: {format(data[hover][s.key] as number | null)}</div>)}
        </div>
      )}
    </div>
  );
}
