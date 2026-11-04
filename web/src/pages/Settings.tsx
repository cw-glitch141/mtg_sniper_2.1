import { useEffect, useState } from 'react';
import { api, type AppSettings } from '../api';
import { ErrorNotice, NumInput, useAsync, useToast } from '../ui';

type Field = { path: string; label: string; kind?: 'num' | 'bool' | 'select' | 'list' | 'text'; options?: [string, string][]; suffix?: string };
type Section = { title: string; hint?: string; fields: Field[] };

const SECTIONS: Section[] = [
  {
    title: 'Kaufregeln', hint: 'Startwerte sind Annahmen, keine nachgewiesen optimalen Werte. Das Trading-Journal zeigt, ob sie sich bewähren.',
    fields: [
      { path: 'rules.minPrice', label: 'Minimales Preisniveau €' }, { path: 'rules.maxPrice', label: 'Maximales Preisniveau €' },
      { path: 'rules.minProfit', label: 'Mindestgewinn €' }, { path: 'rules.minRoiPct', label: 'Ziel-ROI %' }, { path: 'rules.minDiscountPct', label: 'Mindest-Rabatt %' },
      { path: 'rules.smallProfit.enabled', label: 'Small-Profit-Modus', kind: 'bool' }, { path: 'rules.smallProfit.minProfit', label: 'Small-Profit: Mindestgewinn €' },
      { path: 'rules.smallProfit.maxCapital', label: 'Small-Profit: max. Kapital €' }, { path: 'rules.smallProfit.minRoiPct', label: 'Small-Profit: min. ROI %' },
      { path: 'rules.maxCapitalPerCard', label: 'Max. Kapital je Karte €' }, { path: 'rules.maxInventoryCapital', label: 'Max. Gesamtbestand €' },
      { path: 'rules.minConfidence', label: 'Mindest-Confidence (0–100)' }, { path: 'rules.maxOfferAgeHours', label: 'Max. Angebotsalter (Std.)' },
      { path: 'rules.worstCondition', label: 'Schlechtester Zustand', kind: 'select', options: ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'].map(c => [c, c]) },
      { path: 'rules.allowedLanguages', label: 'Erlaubte Sprachen (Kürzel, Komma)', kind: 'list' },
      { path: 'rules.includeFoil', label: 'Foil einbeziehen', kind: 'bool' },
      { path: 'rules.requireNonNegativeConservative', label: 'Kein Verlust im konservativen Szenario', kind: 'bool' },
    ],
  },
  {
    title: 'Gebühren & Kosten',
    fields: [
      { path: 'fees.commissionPct', label: 'Verkaufsprovision %' }, { path: 'fees.paymentFeePct', label: 'Zahlungsgebühr %' }, { path: 'fees.paymentFeeFixed', label: 'Zahlungsgebühr fix €' },
      { path: 'fees.packagingCost', label: 'Verpackung je Verkauf €' }, { path: 'fees.uncoveredShippingCost', label: 'Ungedecktes Porto je Verkauf €' },
      { path: 'fees.returnLossPct', label: 'Retouren-/Verlustrisiko %' }, { path: 'fees.laborMinutes', label: 'Arbeitszeit je Karte (Min.)' },
      { path: 'fees.hourlyRate', label: 'Stundensatz €' }, { path: 'fees.otherAcquisitionCost', label: 'Sonstige Beschaffungskosten €' },
    ],
  },
  {
    title: 'Umsatzsteuer', hint: 'Rechenhilfe, keine Steuerberatung. Differenzbesteuerung nur bei Einkauf ohne Vorsteuerabzug (z. B. von Privatpersonen).',
    fields: [
      { path: 'tax.mode', label: 'Besteuerung', kind: 'select', options: [['kleinunternehmer', 'Kleinunternehmer (§19 UStG)'], ['regular', 'Regelbesteuerung'], ['margin', 'Differenzbesteuerung (§25a)'], ['private', 'Privatverkauf']] },
      { path: 'tax.vatRatePct', label: 'USt-Satz %' }, { path: 'tax.purchaseVatDeductible', label: 'Vorsteuer auf Einkauf abziehbar', kind: 'bool' },
    ],
  },
  {
    title: 'Porto (Einkauf)', hint: 'Richtwerte aus Version 1.1 – trage deine echten Erfahrungswerte ein.',
    fields: [
      { path: 'shipping.homeCountry', label: 'Heimatland', kind: 'select', options: [['de', 'Deutschland'], ['at', 'Österreich'], ['ch', 'Schweiz'], ['nl', 'Niederlande'], ['be', 'Belgien'], ['fr', 'Frankreich'], ['it', 'Italien'], ['es', 'Spanien']] },
      { path: 'shipping.domestic', label: 'Inland Brief €' }, { path: 'shipping.domesticTracked', label: 'Inland versichert €' },
      { path: 'shipping.intl', label: 'Ausland Brief €' }, { path: 'shipping.intlTracked', label: 'Ausland versichert €' },
      { path: 'shipping.trackedFrom', label: 'Versichert ab Warenwert €' },
      { path: 'shipping.marketSignalAssumeDomestic', label: 'Marktsignale: Inlandskauf annehmen', kind: 'bool' },
    ],
  },
  {
    title: 'Wiederverkauf', hint: 'Cardmarket-Referenzpreise sind nicht nach Zustand/Sprache getrennt – die Faktoren sind Annahmen.',
    fields: [
      { path: 'resale.conservativeHaircutPct', label: 'Abschlag konservativ %' }, { path: 'resale.baseHaircutPct', label: 'Abschlag Basis %' },
      { path: 'resale.optimisticHaircutPct', label: 'Abschlag optimistisch %' }, { path: 'resale.unknownConditionFactor', label: 'Faktor Zustand unbekannt' },
      ...['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'].map(c => ({ path: `resale.conditionFactors.${c}`, label: `Zustandsfaktor ${c}` })),
      { path: 'resale.languageFactors.en', label: 'Sprachfaktor Englisch' }, { path: 'resale.languageFactors.de', label: 'Sprachfaktor Deutsch' },
      { path: 'resale.otherLanguageFactor', label: 'Sprachfaktor andere' },
    ],
  },
  {
    title: 'Smart-Deal-Score: Gewichtung',
    fields: [
      { path: 'weights.profit', label: 'Nettoertrag/ROI' }, { path: 'weights.liquidity', label: 'Liquidität (Proxy)' }, { path: 'weights.deviation', label: 'Preisabweichung' },
      { path: 'weights.stability', label: 'Stabilität/Volatilität' }, { path: 'weights.dataQuality', label: 'Datenqualität' }, { path: 'weights.risk', label: 'Risiko' },
    ],
  },
  {
    title: 'Analyse',
    fields: [
      { path: 'analysis.historyMinPrice', label: 'Historie ab Preis €' }, { path: 'analysis.dipThresholdPct', label: 'Price-Dip-Schwelle %' },
      { path: 'analysis.bigDropPct', label: 'Großer Rückgang ab %' }, { path: 'analysis.volatilityMinDays', label: 'Volatilität: min. Tage' },
      { path: 'analysis.staleGuideHours', label: 'Price Guide veraltet nach Std.' }, { path: 'analysis.maxReferenceRatio', label: 'Ausreißer ab Faktor' },
      { path: 'analysis.lowConfidenceScoreCap', label: 'Score-Deckel bei niedriger Confidence' }, { path: 'analysis.maxOpportunities', label: 'Max. Marktsignale je Lauf' },
    ],
  },
  {
    title: 'Alarme',
    fields: [
      { path: 'alerts.enabled', label: 'Alarme aktiv', kind: 'bool' }, { path: 'alerts.minScore', label: 'Mindest-Score' }, { path: 'alerts.minConfidence', label: 'Mindest-Confidence' },
      { path: 'alerts.cooldownHours', label: 'Cooldown (Std.)' }, { path: 'alerts.topN', label: 'Top-N (Ranking/Anomalien)' },
      { path: 'alerts.channels.desktop', label: 'Kanal: Desktop', kind: 'bool' }, { path: 'alerts.channels.telegram', label: 'Kanal: Telegram', kind: 'bool' },
      { path: 'alerts.channels.discord', label: 'Kanal: Discord', kind: 'bool' },
      { path: 'alerts.types.liveOffers', label: 'Neue Live-Angebote', kind: 'bool' }, { path: 'alerts.types.anomalies', label: 'Preisauffälligkeiten', kind: 'bool' },
      { path: 'alerts.types.watchlist', label: 'Watchlist-Zielpreise', kind: 'bool' }, { path: 'alerts.types.bigDrops', label: 'Große Preisrückgänge', kind: 'bool' },
      { path: 'alerts.types.dailyMovers', label: 'Tägliche Marktbewegungen', kind: 'bool' }, { path: 'alerts.types.rankingChanges', label: 'Ranking-Änderungen', kind: 'bool' },
      { path: 'alerts.externalMinPriority', label: 'Telegram/Discord ab Priorität', kind: 'select', options: [['HIGH', 'nur HIGH PRIORITY'], ['MEDIUM', 'HIGH + MEDIUM'], ['WATCH', 'alle inkl. MARKET WATCH']] },
      { path: 'alerts.highMinConservativeProfit', label: 'HIGH: konservativer Gewinn ≥ €' }, { path: 'alerts.highMinConservativeRoiPct', label: 'HIGH: konservativer ROI ≥ %' },
      { path: 'alerts.highMinConfidence', label: 'HIGH: Confidence ≥' }, { path: 'alerts.highMaxOfferAgeHours', label: 'HIGH: Angebot höchstens … Std. alt' },
    ],
  },
  {
    title: 'Kapital- und Risikolimits', hint: 'Fließen als Kaufregeln in jede Empfehlung ein. Max. Kaufbetrag je Karte und Gesamtbestand stehen unter „Kaufregeln“.',
    fields: [
      { path: 'limits.maxCopiesPerCard', label: 'Max. identische Exemplare (inkl. bestellt)' }, { path: 'limits.maxInvestmentPerSet', label: 'Max. Investition je Edition €' },
      { path: 'limits.maxSlowMoverSharePct', label: 'Max. Anteil Langsamdreher %' }, { path: 'limits.slowMoverDays', label: 'Langsamdreher ab … Tagen im Lager' },
      { path: 'limits.minLiquidityReserve', label: 'Mindestreserve €' },
    ],
  },
  {
    title: 'Geschäftsprozesse',
    fields: [
      { path: 'business.laborMinutesPerOrder', label: 'Arbeitszeit je Auftrag (Min.)' }, { path: 'business.laborMinutesPerCard', label: 'Arbeitszeit je verkaufter Karte (Min.)' },
      { path: 'business.laborMinutesPerPurchase', label: 'Arbeitszeit je Einkauf (Min.)' }, { path: 'business.defaultPackagingCost', label: 'Vorschlag Verpackung €' },
      { path: 'business.defaultShippingCost', label: 'Vorschlag Porto Brief €' }, { path: 'business.defaultTrackedShippingCost', label: 'Vorschlag Porto versichert €' },
      { path: 'business.trackedFromOrderValue', label: 'Versichert ab Auftragswert €' }, { path: 'business.overdueShipDays', label: 'Auftrag überfällig nach Tagen' },
      { path: 'business.archiveAfterDays', label: 'Archivieren nach Tagen' }, { path: 'business.defaultWarehouse', label: 'Standard-Lager', kind: 'text' },
      { path: 'business.locationPattern', label: 'Schema Lagerplatz (Regex)', kind: 'text' },
    ],
  },
  {
    title: 'Repricing', hint: 'Vorschläge liegen nie unter max(Verlustgrenze, absoluter Mindestpreis, Mindestgrenze der Charge).',
    fields: [
      { path: 'repricing.targetProfit', label: 'Ziel-Deckungsbeitrag je Karte €' }, { path: 'repricing.targetMarginPct', label: 'Ziel-Marge %' },
      { path: 'repricing.absoluteMinPrice', label: 'Absoluter Mindestpreis €' }, { path: 'repricing.overpricedTolerancePct', label: 'Zu teuer ab Marktwert + %' },
      { path: 'repricing.underpricedTolerancePct', label: 'Zu günstig ab Marktwert − %' }, { path: 'repricing.slowListingDays', label: 'Lange unverkauft ab Tagen' },
      { path: 'repricing.slowStepPct', label: 'Senkungsschritt %' },
    ],
  },
  {
    title: 'Zeitplan',
    fields: [
      { path: 'scheduler.enabled', label: 'Automatischer Import', kind: 'bool' }, { path: 'scheduler.checkIntervalMinutes', label: 'Prüfintervall (Min., ab 15)' },
      { path: 'scheduler.minHoursBetweenImports', label: 'Min. Stunden zwischen Importen' }, { path: 'scheduler.scryfallRefreshDays', label: 'Scryfall alle … Tage' },
    ],
  },
];

const getPath = (o: unknown, p: string): unknown => p.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);
function setPath<T>(o: T, p: string, v: unknown): T {
  const copy = structuredClone(o) as Record<string, unknown>;
  const keys = p.split('.');
  let cur = copy;
  keys.slice(0, -1).forEach(k => { cur[k] = { ...(cur[k] as Record<string, unknown>) }; cur = cur[k] as Record<string, unknown>; });
  cur[keys[keys.length - 1]] = v;
  return copy as T;
}

export function Settings() {
  const toast = useToast();
  const { data, error, reload } = useAsync(() => api.get<{ settings: AppSettings; defaults: AppSettings }>('/api/settings'), []);
  const [s, setS] = useState<AppSettings | null>(null);
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => { if (data) setS(data.settings); }, [data]);
  useEffect(() => { api.get<{ token: string }>('/api/token').then(t => setToken(t.token)).catch(() => setToken(null)); }, []);
  const dirty = !!s && !!data && JSON.stringify(s) !== JSON.stringify(data.settings);

  const save = async () => {
    try { await api.put('/api/settings', s); toast('Gespeichert. Die nächste Analyse nutzt die neuen Werte.'); reload(); } catch (e) { toast((e as Error).message, true); }
  };
  const saveAndAnalyze = async () => {
    try { await api.put('/api/settings', s); await api.post('/api/analyze'); toast('Gespeichert und neu analysiert.'); reload(); } catch (e) { toast((e as Error).message, true); }
  };
  const reset = async () => {
    if (!confirm('Alle Einstellungen auf die Startwerte zurücksetzen?')) return;
    await api.post('/api/settings/reset'); reload(); toast('Zurückgesetzt.');
  };

  return (
    <>
      <div className="page-head">
        <h1>Einstellungen</h1>
        <div className="actions">
          <button className="btn danger" onClick={reset}>Startwerte</button>
          <button className="btn" disabled={!dirty} onClick={save}>Speichern</button>
          <button className="btn primary" disabled={!dirty} onClick={saveAndAnalyze}>Speichern & neu analysieren</button>
        </div>
      </div>
      <ErrorNotice error={error} />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>Browser-Erweiterung verbinden</h2></div>
        <p className="small">Token im Popup der Erweiterung unter „Dashboard“ einfügen und „An Dashboard senden“ einschalten. Die Erweiterung sendet nur Angebote von Seiten, die du selbst öffnest.</p>
        {token ? <code className="token">{token}</code> : <span className="muted small">Token nicht verfügbar.</span>}
      </div>
      {s && SECTIONS.map(sec => (
        <div key={sec.title} className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>{sec.title}</h2></div>
          <div className="form-grid">
            {sec.hint && <div className="hint">{sec.hint}</div>}
            {sec.fields.map(f => {
              const v = getPath(s, f.path);
              const def = data ? getPath(data.defaults, f.path) : undefined;
              const title = def !== undefined ? `Startwert: ${Array.isArray(def) ? def.join(', ') : String(def)}` : undefined;
              if (f.kind === 'bool') return <label key={f.path} className="check" title={title}><input type="checkbox" checked={!!v} onChange={e => setS(setPath(s, f.path, e.target.checked))} />{f.label}</label>;
              if (f.kind === 'select') return <label key={f.path} className="field" title={title}>{f.label}<select value={String(v)} onChange={e => setS(setPath(s, f.path, e.target.value))}>{f.options?.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>;
              if (f.kind === 'text') return <label key={f.path} className="field" title={title}>{f.label}<input type="text" value={String(v ?? '')} onChange={e => setS(setPath(s, f.path, e.target.value))} /></label>;
              if (f.kind === 'list') return <label key={f.path} className="field" title={title}>{f.label}<input type="text" value={(v as string[]).join(', ')} onChange={e => setS(setPath(s, f.path, e.target.value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean)))} /></label>;
              return <label key={f.path} className="field" title={title}>{f.label}<NumInput value={v as number} onChange={n => n != null && n >= 0 && setS(setPath(s, f.path, n))} width={120} /></label>;
            })}
          </div>
        </div>
      ))}
      <p className="small muted">Zugangsdaten für Telegram/Discord stehen nicht hier, sondern in der Datei <code>.env</code> im Projektordner (siehe README). Sie werden nie im Browser angezeigt.</p>
    </>
  );
}
