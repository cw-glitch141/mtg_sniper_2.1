/**
 * Smart Deal Score (0–100) und davon getrennter Confidence Score (0–100).
 *
 * Score-Komponenten (jeweils 0–100, gewichtet nach settings.weights):
 *   profit      erwarteter Nettoertrag / ROI (Basisszenario)
 *   liquidity   PROXY für Nachfrage: Cardmarket liefert keine Verkaufszahlen. Genutzt wird, ob
 *               für gestern/7 Tage/30 Tage überhaupt Durchschnittspreise existieren und wie stark sie streuen.
 *   deviation   Preisabweichung ggü. der (zustandsbereinigten) Referenz
 *   stability   historische Stabilität (eigene Historie, sonst Streuung der Aggregate)
 *   dataQuality Aktualität von Price Guide und Angebot, Zuordnung, Anzahl Referenzwerte
 *   risk        Zustand, Variante, Verkäufer, Versand (100 = geringes Risiko)
 */
import type { AppSettings } from '../domain/settings.ts';
import type { SignalClass, Strategy } from '../domain/types.ts';
import { clamp, round1 } from '../util/num.ts';
import type { GuideMetrics, HistoryMetrics } from './stats.ts';

export interface ScoreInput {
  signalClass: SignalClass;
  strategy: Strategy;
  profitBase: number | null;
  roiBase: number | null;
  profitConservative: number | null;
  discountPct: number | null;
  guide: GuideMetrics;
  guideHasAvg1: boolean;
  guideHasAvg7: boolean;
  guideHasAvg30: boolean;
  history: HistoryMetrics;
  guideAgeHours: number | null;
  offerAgeHours: number | null;   // nur Einzelangebote
  mapped: boolean;
  conditionKnown: boolean;
  condition: string | null;
  foil: boolean;
  sellerSales: number | null;
  sellerType: string | null;
  international: boolean | null;
  capital: number;
  confidenceDelta?: number;       // strategiespezifische Korrektur (mit Begründung)
  confidenceNote?: string;
}

export interface ScoreComponent { value: number; note: string }
export interface ScoreResult {
  score: number;
  confidence: number;
  capped: boolean;
  components: Record<keyof AppSettings['weights'], ScoreComponent>;
  confidenceNotes: string[];
  riskLevel: 'niedrig' | 'mittel' | 'hoch';
}

function profitComponent(i: ScoreInput): ScoreComponent {
  if (i.profitBase == null || i.roiBase == null) return { value: 0, note: 'kein Gewinn berechenbar' };
  if (i.profitBase <= 0) return { value: 0, note: 'kein positiver Nettoertrag' };
  const part = (profit: number) => {
    const roi = clamp((profit / Math.max(i.capital, 0.01)) * 100 / 50 * 100);   // 50 % ROI → volle Punkte
    const abs = clamp(Math.log1p(Math.max(profit, 0)) / Math.log1p(50) * 100); // 50 € → volle Punkte (logarithmisch)
    return profit <= 0 ? 0 : 0.6 * roi + 0.4 * abs;
  };
  // Basis- und konservatives Szenario je zur Hälfte: ein Deal, der nur im Basisfall trägt, zählt weniger.
  const cons = i.profitConservative;
  const v = cons == null ? part(i.profitBase) * 0.5 : 0.5 * part(i.profitBase) + 0.5 * part(cons);
  return { value: v, note: `ROI ${round1(i.roiBase)} %, Ertrag ${i.profitBase.toFixed(2)} €` + (cons != null ? `, konservativ ${cons.toFixed(2)} €` : '') };
}

function liquidityComponent(i: ScoreInput): ScoreComponent {
  let v = 0;
  if (i.guideHasAvg1) v += 35;
  if (i.guideHasAvg7) v += 25;
  if (i.guideHasAvg30) v += 10;
  const cv = i.guide.dispersionCvPct;
  if (cv != null) v += cv < 5 ? 30 : cv < 15 ? 15 : 0;
  const parts = [i.guideHasAvg1 ? 'Verkäufe gestern belegt' : 'kein 1-Tages-Ø (gestern evtl. kein Verkauf)'];
  if (cv != null) parts.push(`Streuung ${round1(cv)} %`);
  return { value: clamp(v), note: 'Proxy: ' + parts.join(', ') };
}

function deviationComponent(i: ScoreInput): ScoreComponent {
  if (i.discountPct == null) return { value: 0, note: 'keine Referenz' };
  return { value: clamp(i.discountPct / 40 * 100), note: `${round1(i.discountPct)} % unter Referenz` };
}

function stabilityComponent(i: ScoreInput): ScoreComponent {
  const vol = i.history.vol30;
  if (vol.value != null) return { value: clamp(100 - vol.value * 12), note: `Tagesvolatilität ${vol.value} % (${vol.n} Tage)` };
  const cv = i.guide.dispersionCvPct;
  if (cv != null) return { value: clamp(100 - cv * 4), note: `aus Aggregaten geschätzt (Streuung ${round1(cv)} %), eigene Historie ${i.history.days} Tage` };
  return { value: 40, note: 'unbekannt – zu wenig Daten' };
}

function dataQualityComponent(i: ScoreInput): ScoreComponent {
  const notes: string[] = [];
  let v = 100;
  if (i.guideAgeHours == null) { v -= 60; notes.push('kein Price Guide'); }
  else if (i.guideAgeHours > 54) { v -= 50; notes.push(`Price Guide ${Math.round(i.guideAgeHours)} h alt`); }
  else if (i.guideAgeHours > 30) { v -= 20; notes.push(`Price Guide ${Math.round(i.guideAgeHours)} h alt`); }
  if (i.offerAgeHours != null) {
    if (i.offerAgeHours > 72) { v -= 50; notes.push(`Angebot ${Math.round(i.offerAgeHours)} h alt`); }
    else if (i.offerAgeHours > 24) { v -= 25; notes.push(`Angebot ${Math.round(i.offerAgeHours)} h alt`); }
    else if (i.offerAgeHours > 6) v -= 10;
  }
  if (i.guide.refsAvailable < 3) { v -= (3 - i.guide.refsAvailable) * 15; notes.push(`${i.guide.refsAvailable}/3 Referenzwerte`); }
  if (!i.mapped) { v -= 10; notes.push('Druck nicht über Scryfall zugeordnet'); }
  return { value: clamp(v), note: notes.join(', ') || 'aktuell und vollständig' };
}

function riskComponent(i: ScoreInput): ScoreComponent {
  const notes: string[] = [];
  let v = 100;
  if (!i.conditionKnown) { v -= 40; notes.push('Zustand unbekannt'); }
  else if (i.condition === 'MIX') { v -= 15; notes.push('Zustandsmix (Aggregat)'); }
  else if (i.condition === 'EX') { v -= 10; notes.push('EX'); }
  else if (i.condition && !['MT', 'NM'].includes(i.condition)) { v -= 25; notes.push(i.condition); }
  if (i.foil) { v -= 5; notes.push('Foil (dünnere Referenz)'); }
  if (i.signalClass === 'LIVE_OFFER' || i.signalClass === 'SIMULATION') {
    if (i.sellerSales != null && i.sellerSales < 50) { v -= 15; notes.push(`Verkäufer ${i.sellerSales} Verkäufe`); }
    if (i.sellerType === 'private') v -= 5;
    if (i.international) { v -= 10; notes.push('Auslandsversand'); }
  }
  if (i.capital > 200) { v -= 10; notes.push('hoher Kapitaleinsatz'); }
  return { value: clamp(v), note: notes.join(', ') || 'gering' };
}

const BASE_CONFIDENCE: Record<Strategy, number> = {
  underpriced_offer: 75,
  price_dip: 60,
  volatility: 60,
  spread_low: 35,
};

function confidence(i: ScoreInput, s: AppSettings): { value: number; notes: string[] } {
  const notes: string[] = [];
  let c = BASE_CONFIDENCE[i.strategy];
  // Getrennte Bedeutung: Bei Marktsignalen bewertet die Confidence nur die Datenlage der Statistik, nicht ein Angebot.
  if (i.signalClass === 'MARKET_SIGNAL') notes.push('Confidence eines Marktmodells (Datenlage der Statistik) – kein Angebot belegt');
  if (i.strategy === 'spread_low') notes.push('Tiefstpreis aus dem Price Guide: Zustand, Sprache und Verfügbarkeit unbekannt');
  if (i.guide.refsAvailable === 0) return { value: 0, notes: ['keine Referenzpreise'] };
  if (i.guide.refRatio != null && i.guide.refRatio > s.analysis.maxReferenceRatio) {
    c -= 25;
    notes.push(`Ausreißerverdacht: Referenzwerte liegen um Faktor ${i.guide.refRatio} auseinander`);
  }
  const cv = i.guide.dispersionCvPct;
  if (cv != null && cv < 10) c += 10;
  if (cv != null && cv > 30) { c -= 15; notes.push('Referenzwerte widersprechen sich stark'); }
  if (i.history.days >= 30) c += 10;
  else if (i.history.days >= 7) c += 5;
  else { c -= 5; notes.push(`eigene Historie erst ${i.history.days} Tag(e)`); }
  if (i.guideAgeHours == null || i.guideAgeHours > s.analysis.staleGuideHours) { c -= 30; notes.push('Price Guide veraltet'); }
  if (i.offerAgeHours != null) {
    if (i.offerAgeHours > s.rules.maxOfferAgeHours) { c -= 30; notes.push('Angebot veraltet – vor Kauf prüfen'); }
    else if (i.offerAgeHours > 24) c -= 10;
  }
  if (i.guide.refsAvailable < 3) c -= 10;
  if (!i.mapped) c -= 5;
  if (!i.guideHasAvg1) c -= 5;
  if (!i.conditionKnown && i.strategy !== 'spread_low') c -= 10;
  if (i.confidenceDelta) {
    c += i.confidenceDelta;
    if (i.confidenceNote) notes.push(i.confidenceNote);
  }
  if (i.strategy === 'spread_low') c = Math.min(c, 45);
  return { value: clamp(c), notes };
}

export function scoreOpportunity(i: ScoreInput, s: AppSettings): ScoreResult {
  const components = {
    profit: profitComponent(i),
    liquidity: liquidityComponent(i),
    deviation: deviationComponent(i),
    stability: stabilityComponent(i),
    dataQuality: dataQualityComponent(i),
    risk: riskComponent(i),
  };
  const w = s.weights;
  const totalW = w.profit + w.liquidity + w.deviation + w.stability + w.dataQuality + w.risk || 1;
  let score = (Object.keys(components) as (keyof typeof components)[])
    .reduce((acc, k) => acc + components[k].value * w[k], 0) / totalW;
  const conf = confidence(i, s);
  let capped = false;
  if (conf.value < s.rules.minConfidence) {
    // Proportional herunterskalieren: bleibt unter der Obergrenze, die Reihenfolge untereinander bleibt erhalten.
    score = score * s.analysis.lowConfidenceScoreCap / 100;
    capped = true;
  }
  for (const c of Object.values(components)) c.value = round1(c.value);
  const r = components.risk.value;
  return {
    score: round1(score), confidence: round1(conf.value), capped, components,
    confidenceNotes: conf.notes,
    riskLevel: r >= 75 ? 'niedrig' : r >= 50 ? 'mittel' : 'hoch',
  };
}
