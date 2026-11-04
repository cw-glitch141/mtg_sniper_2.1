/** Auf Cent runden (kaufmännisch, robust gegen 1.005-Fehler). */
export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function clamp(v: number, min = 0, max = 100): number {
  return v < min ? min : v > max ? max : v;
}

/** Positiver, endlicher Preis oder null. 0 und negative Werte gelten als "kein Preis". */
export function price(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Relative Veränderung in Prozent von `from` nach `to`; null, wenn nicht berechenbar. */
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || from <= 0) return null;
  return ((to - from) / from) * 100;
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Stichproben-Standardabweichung (n-1). */
export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Variationskoeffizient in Prozent (Streuung relativ zum Mittelwert). */
export function cvPct(xs: number[]): number | null {
  const m = mean(xs);
  const s = stdev(xs);
  if (m == null || s == null || m <= 0) return null;
  return (s / m) * 100;
}

export function nonNull<T>(xs: (T | null | undefined)[]): T[] {
  return xs.filter((x): x is T => x != null);
}
