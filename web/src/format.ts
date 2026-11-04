const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const numFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

export const euro = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : eurFmt.format(v));
export const num = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v) ? '–' : new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(v);
export const pct = (v: number | null | undefined, signed = false) =>
  v == null || !Number.isFinite(v) ? '–' : (signed && v > 0 ? '+' : '') + numFmt.format(v) + ' %';
export const int = (v: number | null | undefined) => (v == null ? '–' : new Intl.NumberFormat('de-DE').format(v));

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–';
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('de-DE') : '–';
}

export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '–';
  const min = Math.round(ms / 60000);
  if (min < 2) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 48) return `vor ${h} Std.`;
  return `vor ${Math.round(h / 24)} Tagen`;
}

/** Eingabe "12,50" oder "12.50" → 12.5; leer → null; ungültig → NaN. */
export function parseNum(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  return Number(t.replace(/\s|€/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
}

export const LANG_LABEL: Record<string, string> = {
  en: 'Englisch', de: 'Deutsch', fr: 'Französisch', it: 'Italienisch', es: 'Spanisch', pt: 'Portugiesisch',
  ja: 'Japanisch', ko: 'Koreanisch', ru: 'Russisch', zhs: 'Chinesisch (vereinf.)', zht: 'Chinesisch (trad.)',
};

export const STATUS_LABEL: Record<string, string> = {
  ordered: 'bestellt', delivered: 'geliefert', listed: 'angeboten', sold: 'verkauft', returned: 'retourniert',
};

export const STRATEGY_LABEL: Record<string, string> = {
  underpriced_offer: 'Einzelangebot', price_dip: 'Price-Dip', volatility: 'Volatilität', spread_low: 'Spread Tiefstpreis',
};
