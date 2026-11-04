/**
 * Kennzahlen aus (a) den Aggregaten des aktuellen Price Guides und (b) der eigenen
 * täglichen Snapshot-Historie. Fehlende Historie wird NIE aufgefüllt: jede Kennzahl
 * meldet, auf wie vielen Datenpunkten sie beruht, und ist null, wenn diese nicht reichen.
 */
import type { GuidePrices, SnapshotPoint } from '../domain/types.ts';
import { cvPct, mean, median, nonNull, pctChange, round2, stdev } from '../util/num.ts';

export interface Metric { value: number | null; n: number; note?: string }

const DAY = 864e5;
const toTime = (d: string) => Date.parse(d + 'T00:00:00Z');

/** Wert des Feldes am letzten Snapshot, der mindestens `days` Tage vor dem neuesten liegt (Toleranz 2 Tage). */
function valueDaysAgo(series: SnapshotPoint[], field: keyof SnapshotPoint, days: number): number | null {
  if (!series.length) return null;
  const last = toTime(series[series.length - 1].date);
  const target = last - days * DAY;
  for (let i = series.length - 2; i >= 0; i--) {
    const t = toTime(series[i].date);
    if (t <= target) {
      if (target - t > 2 * DAY) return null;
      const v = series[i][field];
      return typeof v === 'number' ? v : null;
    }
  }
  return null;
}

export function changePct(series: SnapshotPoint[], field: 'trend' | 'avg7' | 'avg30' | 'low', days: number): Metric {
  const cur = series.length ? series[series.length - 1][field] : null;
  const prev = valueDaysAgo(series, field, days);
  const v = pctChange(prev, cur);
  return { value: v == null ? null : round2(v), n: series.length, note: v == null ? `Historie < ${days} Tage` : undefined };
}

function windowValues(series: SnapshotPoint[], field: keyof SnapshotPoint, days: number): number[] {
  if (!series.length) return [];
  const last = toTime(series[series.length - 1].date);
  return nonNull(series.filter(p => last - toTime(p.date) < days * DAY).map(p => p[field] as number | null));
}

/** Gleitender Durchschnitt; erst ab 70 % Abdeckung des Fensters berechnet. */
export function movingAverage(series: SnapshotPoint[], field: 'trend' | 'low', days: number): Metric {
  const xs = windowValues(series, field, days);
  if (xs.length < Math.ceil(days * 0.7)) return { value: null, n: xs.length, note: `nur ${xs.length} von ${days} Tagen` };
  return { value: round2(mean(xs) as number), n: xs.length };
}

/** Tägliche Volatilität: Standardabweichung der logarithmischen Tagesrenditen in %. */
export function volatility(series: SnapshotPoint[], field: 'trend' | 'low', days: number, minPoints: number): Metric {
  const pts = series.filter((_, i) => i >= series.length - days);
  const rets: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1][field], b = pts[i][field];
    const gap = (toTime(pts[i].date) - toTime(pts[i - 1].date)) / DAY;
    if (a && b && a > 0 && b > 0 && gap <= 3) rets.push(Math.log(b / a));
  }
  if (rets.length + 1 < minPoints) return { value: null, n: rets.length + 1, note: `mindestens ${minPoints} Tage nötig` };
  const s = stdev(rets);
  return { value: s == null ? null : round2(s * 100), n: rets.length + 1 };
}

export interface RangeInfo { min: number; max: number; median: number; percentile: number; drawdownPct: number; n: number }

/** Schwankungsbreite und Lage des aktuellen Werts im Fenster (0 = Tiefststand, 100 = Höchststand). */
export function rangeInfo(series: SnapshotPoint[], field: 'trend' | 'low', days: number, minPoints: number): RangeInfo | null {
  const xs = windowValues(series, field, days);
  if (xs.length < minPoints) return null;
  const cur = xs[xs.length - 1];
  const below = xs.filter(x => x < cur).length;
  const max = Math.max(...xs);
  return {
    min: Math.min(...xs), max, median: round2(median(xs) as number),
    percentile: round2(below / (xs.length - 1 || 1) * 100),
    drawdownPct: round2((max - cur) / max * 100), n: xs.length,
  };
}

/** z-Score des aktuellen Werts gegenüber dem Fenster (ohne den aktuellen Punkt). */
export function zScore(series: SnapshotPoint[], field: 'trend' | 'low', days: number, minPoints: number): Metric {
  const xs = windowValues(series, field, days);
  if (xs.length < minPoints + 1) return { value: null, n: xs.length, note: `mindestens ${minPoints + 1} Tage nötig` };
  const cur = xs[xs.length - 1];
  const hist = xs.slice(0, -1);
  const m = mean(hist) as number, s = stdev(hist);
  if (!s) return { value: 0, n: xs.length };
  return { value: round2((cur - m) / s), n: xs.length };
}

/**
 * Potenzielle Preisumkehr: mindestens `downDays` Rückgänge in Folge, danach ein Anstieg am letzten Tag.
 * Nur ein Hinweis, kein Kaufsignal.
 */
export function reversalSignal(series: SnapshotPoint[], downDays = 3): boolean {
  const xs = nonNull(series.slice(-(downDays + 2)).map(p => p.trend));
  if (xs.length < downDays + 2) return false;
  for (let i = 1; i <= downDays; i++) if (!(xs[i] < xs[i - 1])) return false;
  return xs[xs.length - 1] > xs[xs.length - 2];
}

/** Kennzahlen, die schon am ersten Tag aus den Cardmarket-Aggregaten berechenbar sind. */
export interface GuideMetrics {
  avg1VsAvg30Pct: number | null;
  avg7VsAvg30Pct: number | null;
  trendVsAvg30Pct: number | null;
  lowVsTrendPct: number | null;
  dispersionCvPct: number | null; // Streuung von avg1/avg7/avg30/trend
  refsAvailable: number;          // wie viele von trend/avg7/avg30 vorhanden sind
  refRatio: number | null;        // größter / kleinster Wert von avg1/avg7/avg30/trend (Ausreißer-Indikator)
}

/** Ausreißerverdacht: die Cardmarket-Aggregate einer Variante liegen um mehr als `maxRatio` auseinander. */
export function implausible(gm: GuideMetrics, maxRatio: number): boolean {
  return gm.refRatio != null && gm.refRatio > maxRatio;
}

export function guideMetrics(g: GuidePrices): GuideMetrics {
  const r = (x: number | null) => (x == null ? null : round2(x));
  const disp = nonNull([g.avg1, g.avg7, g.avg30, g.trend]).filter(x => x > 0);
  return {
    refRatio: disp.length >= 2 ? round2(Math.max(...disp) / Math.min(...disp)) : null,
    avg1VsAvg30Pct: r(pctChange(g.avg30, g.avg1)),
    avg7VsAvg30Pct: r(pctChange(g.avg30, g.avg7)),
    trendVsAvg30Pct: r(pctChange(g.avg30, g.trend)),
    lowVsTrendPct: r(pctChange(g.trend, g.low)),
    dispersionCvPct: disp.length >= 3 ? r(cvPct(disp)) : null,
    refsAvailable: nonNull([g.trend, g.avg7, g.avg30]).length,
  };
}

export interface HistoryMetrics {
  days: number;
  change1d: Metric; change7d: Metric; change30d: Metric;
  ma7: Metric; ma30: Metric;
  vol30: Metric;
  range30: RangeInfo | null;
  z30: Metric;
  reversal: boolean;
}

export function historyMetrics(series: SnapshotPoint[], minVolDays: number): HistoryMetrics {
  return {
    days: series.length,
    change1d: changePct(series, 'trend', 1),
    change7d: changePct(series, 'trend', 7),
    change30d: changePct(series, 'trend', 30),
    ma7: movingAverage(series, 'trend', 7),
    ma30: movingAverage(series, 'trend', 30),
    vol30: volatility(series, 'trend', 30, minVolDays),
    range30: rangeInfo(series, 'trend', 30, minVolDays),
    z30: zScore(series, 'trend', 30, 7),
    reversal: reversalSignal(series),
  };
}
