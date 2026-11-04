/**
 * Alle fachlichen Einstellungen mit Startwerten. Die Startwerte sind Annahmen,
 * KEINE nachgewiesen optimalen Werte – sie sollen anhand echter Trades
 * (Trading-Journal, Entscheidungsprotokoll) überprüft und angepasst werden.
 */
export type TaxMode = 'private' | 'kleinunternehmer' | 'regular' | 'margin';

export interface AppSettings {
  rules: {
    minPrice: number;          // Referenzpreis-Untergrenze (€)
    maxPrice: number;          // Referenzpreis-Obergrenze (€)
    minProfit: number;         // Mindest-Deckungsbeitrag im Basisszenario (€)
    minRoiPct: number;         // Ziel-ROI (%)
    minDiscountPct: number;    // Mindest-Rabatt ggü. Basis-Wiederverkaufsreferenz (%)
    smallProfit: { enabled: boolean; minProfit: number; maxCapital: number; minRoiPct: number };
    maxCapitalPerCard: number;
    maxInventoryCapital: number;
    minConfidence: number;     // Mindest-Datenqualität (Confidence 0–100)
    maxOfferAgeHours: number;  // ältere Einzelangebote gelten als veraltet
    allowedLanguages: string[];
    worstCondition: string;    // schlechtester akzeptierter Zustand
    includeFoil: boolean;
    requireNonNegativeConservative: boolean; // konservatives Szenario darf keinen Verlust zeigen
  };
  fees: {
    commissionPct: number;          // Cardmarket-Verkaufsprovision (auf den Kartenpreis)
    paymentFeePct: number;
    paymentFeeFixed: number;
    packagingCost: number;          // je Verkauf
    uncoveredShippingCost: number;  // Porto, das der Käufer nicht bezahlt (je Verkauf)
    returnLossPct: number;          // erwartete Retouren-/Verlustquote auf den Verkaufspreis
    laborMinutes: number;           // kalkulatorische Arbeitszeit je Karte (Ein- + Verkauf)
    hourlyRate: number;             // €/Stunde
    otherAcquisitionCost: number;   // sonstige Beschaffungskosten je Karte
  };
  shipping: {
    homeCountry: string;
    domestic: number;
    domesticTracked: number;
    intl: number;
    intlTracked: number;
    trackedFrom: number;
    marketSignalAssumeDomestic: boolean; // Marktsignale: Kauf bei Inlandsverkäufer annehmen (Cardmarket-Länderfilter)
  };
  tax: {
    mode: TaxMode;
    vatRatePct: number;
    purchaseVatDeductible: boolean; // nur bei Regelbesteuerung und Einkauf mit ausgewiesener USt
  };
  resale: {
    conservativeHaircutPct: number;
    baseHaircutPct: number;
    optimisticHaircutPct: number;
    conditionFactors: Record<string, number>;
    unknownConditionFactor: number;
    languageFactors: Record<string, number>;
    otherLanguageFactor: number;
  };
  weights: { profit: number; liquidity: number; deviation: number; stability: number; dataQuality: number; risk: number };
  analysis: {
    historyMinPrice: number;     // ab diesem Preis werden tägliche Snapshots gespeichert
    dipThresholdPct: number;
    bigDropPct: number;
    volatilityMinDays: number;
    staleGuideHours: number;
    maxReferenceRatio: number;   // Aggregate weiter auseinander → Ausreißerverdacht
    lowConfidenceScoreCap: number;
    maxOpportunities: number;
  };
  alerts: {
    enabled: boolean;
    minScore: number;
    minConfidence: number;
    cooldownHours: number;
    topN: number;
    channels: { dashboard: boolean; desktop: boolean; telegram: boolean; discord: boolean };
    types: { dailyMovers: boolean; anomalies: boolean; liveOffers: boolean; watchlist: boolean; bigDrops: boolean; rankingChanges: boolean };
    /** HIGH PRIORITY: frisches Live-Angebot mit hoher konservativer Rentabilität und eingehaltenen Limits. */
    highMinConservativeProfit: number;
    highMinConservativeRoiPct: number;
    highMinConfidence: number;
    highMaxOfferAgeHours: number;
    externalMinPriority: string;     // 'HIGH' | 'MEDIUM' | 'WATCH' – ab dieser Priorität an Telegram/Discord
  };
  scheduler: { enabled: boolean; checkIntervalMinutes: number; minHoursBetweenImports: number; scryfallRefreshDays: number };
  /** Kapital- und Risikogrenzen (2.1). Kaufbetrag je Karte und Gesamtbestand stehen in rules. */
  limits: {
    maxCopiesPerCard: number;        // identische Exemplare (Produkt + Finish) inkl. bestellter
    maxInvestmentPerSet: number;     // € Einstand je Edition inkl. bestellter Ware
    maxSlowMoverSharePct: number;    // Anteil langsam verkäuflicher Ware am Bestandswert
    slowMoverDays: number;           // ab so vielen Tagen im Lager gilt eine Charge als langsam
    minLiquidityReserve: number;     // Mindestreserve für laufende Kosten (€)
  };
  business: {
    laborMinutesPerOrder: number;    // Kommissionieren, Packen, Versand je Auftrag
    laborMinutesPerCard: number;     // je verkaufter Karte (Einstellen, Prüfen)
    laborMinutesPerPurchase: number; // je Einkaufsauftrag (Kaufen, Wareneingang)
    defaultPackagingCost: number;    // Vorschlag je Auftrag
    defaultShippingCost: number;     // Vorschlag Porto je Auftrag (Brief)
    defaultTrackedShippingCost: number;
    trackedFromOrderValue: number;
    defaultWarehouse: string;
    locationPattern: string;         // Regulärer Ausdruck für Lagerplatz-Codes, z. B. A01
    overdueShipDays: number;         // Aufträge älter als n Tage ohne Versand → priorisieren
    archiveAfterDays: number;
  };
  repricing: {
    targetProfit: number;            // gewünschter Deckungsbeitrag je Karte (€)
    targetMarginPct: number;         // gewünschte Marge auf den Verkaufspreis (%)
    absoluteMinPrice: number;        // nie unter diesem Preis empfehlen
    overpricedTolerancePct: number;  // Angebotspreis > Marktwert + x % → zu teuer
    underpricedTolerancePct: number; // Angebotspreis < Marktwert − x % → Preis anheben
    slowListingDays: number;         // so lange angeboten ohne Verkauf → Preissenkung prüfen
    slowStepPct: number;             // Schrittweite der Senkung
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  rules: {
    minPrice: 15,
    maxPrice: 500,
    minProfit: 5,
    minRoiPct: 15,
    minDiscountPct: 12,
    smallProfit: { enabled: true, minProfit: 3, maxCapital: 40, minRoiPct: 20 },
    maxCapitalPerCard: 250,
    maxInventoryCapital: 2000,
    minConfidence: 50,
    maxOfferAgeHours: 48,
    allowedLanguages: ['en', 'de'],
    worstCondition: 'EX',
    includeFoil: true,
    requireNonNegativeConservative: false, // optional strenger: kein Verlust im konservativen Szenario
  },
  fees: {
    commissionPct: 5,
    paymentFeePct: 0,
    paymentFeeFixed: 0,
    packagingCost: 0.35,
    uncoveredShippingCost: 0.2,
    returnLossPct: 2,
    laborMinutes: 5,
    hourlyRate: 12,
    otherAcquisitionCost: 0,
  },
  // Porto-Richtwerte aus Version 1.1.0 – an eigene Erfahrungswerte anpassen.
  shipping: { homeCountry: 'de', domestic: 1.25, domesticTracked: 3.95, intl: 2.5, intlTracked: 9, trackedFrom: 25, marketSignalAssumeDomestic: true },
  tax: { mode: 'kleinunternehmer', vatRatePct: 19, purchaseVatDeductible: false },
  resale: {
    conservativeHaircutPct: 12,
    baseHaircutPct: 5,
    optimisticHaircutPct: 0,
    // Cardmarket-Referenzpreise sind nicht nach Zustand getrennt. Die Faktoren sind Annahmen.
    conditionFactors: { MT: 1, NM: 1, EX: 0.9, GD: 0.8, LP: 0.7, PL: 0.55, PO: 0.35 },
    unknownConditionFactor: 0.8,
    languageFactors: { en: 1, de: 0.95 },
    otherLanguageFactor: 0.8,
  },
  weights: { profit: 35, liquidity: 25, deviation: 15, stability: 10, dataQuality: 10, risk: 5 },
  analysis: {
    historyMinPrice: 2,
    dipThresholdPct: 15,
    bigDropPct: 20,
    volatilityMinDays: 14,
    staleGuideHours: 36,
    maxReferenceRatio: 3,
    lowConfidenceScoreCap: 45,
    maxOpportunities: 1500,
  },
  alerts: {
    enabled: true,
    minScore: 60,
    minConfidence: 55,
    cooldownHours: 24,
    topN: 10,
    channels: { dashboard: true, desktop: true, telegram: false, discord: false },
    types: { dailyMovers: true, anomalies: true, liveOffers: true, watchlist: true, bigDrops: true, rankingChanges: true },
    highMinConservativeProfit: 3,
    highMinConservativeRoiPct: 10,
    highMinConfidence: 65,
    highMaxOfferAgeHours: 12,
    externalMinPriority: 'MEDIUM',
  },
  scheduler: { enabled: true, checkIntervalMinutes: 120, minHoursBetweenImports: 20, scryfallRefreshDays: 7 },
  limits: { maxCopiesPerCard: 4, maxInvestmentPerSet: 600, maxSlowMoverSharePct: 35, slowMoverDays: 60, minLiquidityReserve: 200 },
  business: {
    laborMinutesPerOrder: 6, laborMinutesPerCard: 1.5, laborMinutesPerPurchase: 4,
    defaultPackagingCost: 0.35, defaultShippingCost: 1.25, defaultTrackedShippingCost: 3.95, trackedFromOrderValue: 25,
    defaultWarehouse: 'HAUPT', locationPattern: '^[A-Z]{1,2}[0-9]{2,3}$', overdueShipDays: 2, archiveAfterDays: 30,
  },
  repricing: {
    targetProfit: 2, targetMarginPct: 10, absoluteMinPrice: 0.25,
    overpricedTolerancePct: 10, underpricedTolerancePct: 15, slowListingDays: 45, slowStepPct: 5,
  },
};

export const PRIORITIES = ['HIGH', 'MEDIUM', 'WATCH'] as const;
export type Priority = typeof PRIORITIES[number];

type Json = unknown;

/**
 * Teil-Einstellungen gegen die Standardwerte prüfen und zusammenführen.
 * Unbekannte Schlüssel werden verworfen, falsche Typen führen zu einer Fehlermeldung
 * (keine stillschweigenden Ersatzwerte für Nutzereingaben).
 */
export function mergeSettings(base: AppSettings, patch: Json): { settings: AppSettings; errors: string[] } {
  const errors: string[] = [];
  function walk(def: Json, cur: Json, p: Json, path: string): Json {
    if (p === undefined) return cur;
    if (Array.isArray(def)) {
      if (!Array.isArray(p) || !p.every(x => typeof x === 'string')) { errors.push(`${path}: Liste von Texten erwartet`); return cur; }
      return p;
    }
    if (def !== null && typeof def === 'object') {
      if (p === null || typeof p !== 'object' || Array.isArray(p)) { errors.push(`${path}: Objekt erwartet`); return cur; }
      const isMap = path.endsWith('conditionFactors') || path.endsWith('languageFactors');
      const out: Record<string, Json> = { ...(cur as Record<string, Json>) };
      for (const [k, v] of Object.entries(p as Record<string, Json>)) {
        if (isMap) {
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 2) errors.push(`${path}.${k}: Faktor zwischen 0 und 2 erwartet`);
          else out[k] = v;
          continue;
        }
        if (!(k in (def as Record<string, Json>))) continue;
        out[k] = walk((def as Record<string, Json>)[k], (cur as Record<string, Json>)[k], v, `${path}.${k}`);
      }
      return out;
    }
    if (typeof def === 'number') {
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) { errors.push(`${path}: nicht-negative Zahl erwartet`); return cur; }
      return p;
    }
    if (typeof def === 'boolean') {
      if (typeof p !== 'boolean') { errors.push(`${path}: true/false erwartet`); return cur; }
      return p;
    }
    if (typeof def === 'string') {
      if (typeof p !== 'string') { errors.push(`${path}: Text erwartet`); return cur; }
      return p;
    }
    return cur;
  }
  const merged = walk(DEFAULT_SETTINGS, base, patch, 'settings') as AppSettings;
  if (!['private', 'kleinunternehmer', 'regular', 'margin'].includes(merged.tax.mode)) {
    errors.push('settings.tax.mode: private | kleinunternehmer | regular | margin');
    merged.tax.mode = base.tax.mode;
  }
  if (merged.rules.minPrice > merged.rules.maxPrice) errors.push('settings.rules: minPrice darf nicht größer als maxPrice sein');
  if (!(PRIORITIES as readonly string[]).includes(merged.alerts.externalMinPriority)) {
    errors.push('settings.alerts.externalMinPriority: HIGH | MEDIUM | WATCH');
    merged.alerts.externalMinPriority = base.alerts.externalMinPriority;
  }
  try { new RegExp(merged.business.locationPattern); } catch { errors.push('settings.business.locationPattern: ungültiger regulärer Ausdruck'); merged.business.locationPattern = base.business.locationPattern; }
  if (merged.limits.maxSlowMoverSharePct > 100) errors.push('settings.limits.maxSlowMoverSharePct: höchstens 100');
  if (merged.fees.commissionPct >= 100) errors.push('settings.fees.commissionPct: muss unter 100 liegen');
  return { settings: merged, errors };
}
