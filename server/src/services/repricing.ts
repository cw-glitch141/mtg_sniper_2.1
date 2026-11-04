/**
 * Repricing-Empfehlungen (nur Vorschläge – ohne autorisierte Marktplatz-Schnittstelle wird nichts automatisch geändert).
 *
 *   Verlustgrenze  = kleinster Preis mit Deckungsbeitrag ≥ 0 (tatsächlicher Einstand, Gebühren, Steuerbehandlung der Charge)
 *   Untergrenze    = max(Verlustgrenze, absoluter Mindestpreis, individuelle Mindestgrenze der Charge)
 *   Zielpreis      = kleinster Preis mit Ziel-Deckungsbeitrag und Ziel-Marge
 * Kein Vorschlag liegt je unter der Untergrenze. Liegt der Marktwert darunter, wird das ausdrücklich gemeldet.
 */
import type { Db } from '../db/database.ts';
import type { AppSettings } from '../domain/settings.ts';
import { minSellPrice, type VatTreatment } from '../analytics/accounting.ts';
import { estimateResale } from '../analytics/resale.ts';
import { round2 } from '../util/num.ts';
import { ApiError } from '../api/http.ts';
import { toGuide } from './products.ts';
import { getLot, lotCode, patchLot, unitAlloc, unitFullCost, type LotRow } from './stock.ts';

export type RepriceAction = 'list' | 'below_floor' | 'overpriced' | 'underpriced' | 'slow' | 'at_floor' | 'ok' | 'no_market';

export const ACTION_LABEL: Record<RepriceAction, string> = {
  list: 'Noch nicht angeboten', below_floor: 'Unter Verlustgrenze', overpriced: 'Zu teuer', underpriced: 'Zu günstig', slow: 'Lange unverkauft',
  at_floor: 'An der Untergrenze', ok: 'Preis passt', no_market: 'Kein Marktwert',
};

export interface PriceFloors { breakEven: number; floor: number; target: number }

export function floorsForLot(l: LotRow, s: AppSettings): PriceFloors {
  const t = l.vat_treatment as VatTreatment;
  const breakEven = minSellPrice(l.unit_cost, unitAlloc(l), t, l.vat_rate_pct, s, 0, 0);
  const target = minSellPrice(l.unit_cost, unitAlloc(l), t, l.vat_rate_pct, s, s.repricing.targetProfit, s.repricing.targetMarginPct);
  const floor = Math.max(breakEven, s.repricing.absoluteMinPrice, l.min_price_override ?? 0);
  return { breakEven, floor: round2(floor), target: round2(Math.max(target, floor)) };
}

export function repricingSuggestions(db: Db, s: AppSettings, opts: { onlyActionable?: boolean } = {}) {
  const r = s.repricing;
  const lots = db.all<LotRow & { trend: number | null; avg: number | null; low: number | null; avg1: number | null; avg7: number | null; avg30: number | null; source_created_at: string | null; location_code: string | null }>(`
    SELECT s.*, pl.trend, pl.avg, pl.low, pl.avg1, pl.avg7, pl.avg30, pl.source_created_at, loc.code AS location_code
    FROM stock_lots s LEFT JOIN price_latest pl ON pl.product_id = s.product_id AND pl.finish = s.finish AND pl.source = 'cardmarket_price_guide'
    LEFT JOIN locations loc ON loc.id = s.location_id
    WHERE s.ownership = 'business' AND s.qty_on_hand - s.qty_reserved > 0 ORDER BY s.name COLLATE NOCASE`);
  const out = lots.map(l => {
    const f = floorsForLot(l, s);
    const market = l.source_created_at ? estimateResale(toGuide(l as never), s.resale, l.condition, l.language) : null;
    const mBase = market?.base ?? null;
    const daysListed = l.listed_at ? Math.floor((Date.now() - Date.parse(l.listed_at)) / 864e5) : null;
    const cost = unitFullCost(l);
    let action: RepriceAction = 'ok';
    let suggested: number | null = null;
    const notes: string[] = [];
    const clampFloor = (p: number) => round2(Math.max(p, f.floor));

    if (l.list_price == null) {
      action = 'list';
      suggested = clampFloor(Math.max(f.target, mBase ?? f.target));
      if (mBase == null) notes.push('Kein Marktwert verfügbar – Vorschlag = Zielpreis aus Einstand.');
    } else if (l.list_price < f.floor - 0.004) {
      action = 'below_floor';
      suggested = f.floor;
      notes.push(`Angebotspreis ${l.list_price.toFixed(2)} € liegt unter der Untergrenze ${f.floor.toFixed(2)} € – Verkauf brächte Verlust.`);
    } else if (mBase != null && l.list_price > mBase * (1 + r.overpricedTolerancePct / 100)) {
      action = 'overpriced';
      suggested = clampFloor(mBase);
    } else if (mBase != null && l.list_price < mBase * (1 - r.underpricedTolerancePct / 100)) {
      action = 'underpriced';
      suggested = clampFloor(mBase);
    } else if (daysListed != null && daysListed >= r.slowListingDays) {
      const step = l.list_price * (1 - r.slowStepPct / 100);
      if (l.list_price <= f.floor + 0.004) { action = 'at_floor'; notes.push('Bereits an der Untergrenze – keine weitere Senkung empfohlen (anderer Kanal oder halten).'); }
      else { action = 'slow'; suggested = clampFloor(step); }
    } else if (mBase == null) {
      action = 'no_market';
    }
    if (mBase != null && mBase < f.floor) notes.push(`Marktwert ${mBase.toFixed(2)} € liegt unter der Verlustgrenze – Verkauf zum Marktpreis brächte Verlust.`);
    if (suggested != null && l.list_price != null && Math.abs(suggested - l.list_price) < 0.01) { action = 'ok'; suggested = null; }
    return {
      lotId: l.id, lotCode: lotCode(l.id), productId: l.product_id, name: l.name, setName: l.set_name, finish: l.finish, condition: l.condition, language: l.language,
      location: l.location_code, qtyAvailable: l.qty_on_hand - l.qty_reserved, unitFullCost: round2(cost), listPrice: l.list_price, listedAt: l.listed_at, daysListed,
      ageDays: Math.floor((Date.now() - Date.parse(l.received_at)) / 864e5),
      marketBase: mBase, marketConservative: market?.conservative ?? null, marketDataDate: l.source_created_at,
      marketVsCostPct: mBase != null && cost > 0 ? round2((mBase - cost) / cost * 100) : null,
      breakEven: f.breakEven, floor: f.floor, target: f.target, action, actionLabel: ACTION_LABEL[action], suggested, notes,
    };
  });
  return opts.onlyActionable ? out.filter(x => x.action !== 'ok' && x.action !== 'no_market') : out;
}

/** Vorschlag übernehmen bzw. Preis setzen – unter der Untergrenze nur mit ausdrücklicher Bestätigung. */
export function applyPrice(db: Db, s: AppSettings, lotId: number, price: number, acceptBelowFloor = false, platform?: string | null): void {
  const lot = getLot(db, lotId);
  if (lot.ownership !== 'business') throw new ApiError(400, 'Privatbestand kann nicht angeboten werden');
  if (!(price > 0)) throw new ApiError(400, 'Preis muss positiv sein');
  const f = floorsForLot(lot, s);
  if (price < f.floor - 0.004 && !acceptBelowFloor) {
    throw new ApiError(409, `Preis ${price.toFixed(2)} € liegt unter der Untergrenze ${f.floor.toFixed(2)} € (Verlustgrenze ${f.breakEven.toFixed(2)} €). Zum Übernehmen ausdrücklich bestätigen.`, { floor: f.floor });
  }
  patchLot(db, s, lotId, { listPrice: round2(price), listPlatform: platform ?? lot.list_platform ?? 'cardmarket' });
}
