/**
 * Konservative Schätzung des erreichbaren Wiederverkaufspreises – ausdrücklich NICHT einfach der Trendpreis.
 *
 *   konservativ = min(trend, avg7, avg30) × (1 − Abschlag konservativ)
 *   basis       = median(trend, avg7, avg30) × (1 − Abschlag basis)
 *   optimistisch= max(trend, avg7, avg30) × (1 − Abschlag optimistisch)   (nicht garantiert)
 * jeweils × Zustandsfaktor × Sprachfaktor (Annahmen, da Cardmarket-Referenzen nicht nach Zustand/Sprache getrennt sind).
 *
 * Fehlt jeder Referenzwert, gibt es KEINE Schätzung (kein stillschweigender Ersatzwert).
 */
import type { AppSettings } from '../domain/settings.ts';
import type { GuidePrices } from '../domain/types.ts';
import { median, nonNull, round2 } from '../util/num.ts';
import type { Scenario } from './profit.ts';

export interface ResaleEstimate extends Scenario {
  refs: number[];
  conditionFactor: number;
  languageFactor: number;
  notes: string[];
}

/**
 * Sonderwert 'MIX': Einkaufsbasis und Referenzen beziehen sich auf denselben Zustandsmix
 * (z. B. 1-Tages-Ø vs. 30-Tages-Ø) → kein zusätzlicher Abschlag.
 */
export const CONDITION_MIX = 'MIX';

export function conditionFactor(condition: string | null | undefined, r: AppSettings['resale']): { factor: number; known: boolean } {
  if (condition === CONDITION_MIX) return { factor: 1, known: true };
  if (condition && r.conditionFactors[condition] != null) return { factor: r.conditionFactors[condition], known: true };
  return { factor: r.unknownConditionFactor, known: false };
}

export function languageFactor(lang: string | null | undefined, r: AppSettings['resale']): number {
  if (lang && r.languageFactors[lang] != null) return r.languageFactors[lang];
  return lang ? r.otherLanguageFactor : 1;
}

export function estimateResale(
  g: GuidePrices, r: AppSettings['resale'], condition: string | null, language: string | null,
): ResaleEstimate {
  const refs = nonNull([g.trend, g.avg7, g.avg30]).filter(x => x > 0);
  const cf = conditionFactor(condition, r);
  const lf = languageFactor(language, r);
  const notes: string[] = [];
  if (!refs.length) {
    return { conservative: null, base: null, optimistic: null, refs, conditionFactor: cf.factor, languageFactor: lf, notes: ['Keine Referenzpreise (Trend/7-/30-Tage-Ø) vorhanden – keine Schätzung möglich.'] };
  }
  if (refs.length < 3) notes.push(`Nur ${refs.length} von 3 Referenzwerten vorhanden.`);
  if (condition === CONDITION_MIX) notes.push('Einkaufsbasis und Referenz beziehen sich auf denselben Zustandsmix (kein Zustandsabschlag).');
  else if (!cf.known) notes.push(`Zustand unbekannt – Faktor ${cf.factor} angenommen.`);
  else if (cf.factor !== 1) notes.push(`Zustandsfaktor ${condition}: ${cf.factor}.`);
  if (lf !== 1) notes.push(`Sprachfaktor ${language ?? '?'}: ${lf}.`);
  const k = cf.factor * lf;
  const cons = Math.min(...refs) * (1 - r.conservativeHaircutPct / 100) * k;
  const base = (median(refs) as number) * (1 - r.baseHaircutPct / 100) * k;
  const opt = Math.max(...refs) * (1 - r.optimisticHaircutPct / 100) * k;
  return {
    conservative: round2(cons), base: round2(base), optimistic: round2(opt),
    refs, conditionFactor: cf.factor, languageFactor: lf, notes,
  };
}
