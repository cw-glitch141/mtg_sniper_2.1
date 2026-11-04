/**
 * Strategie 5 – Verkäufer-Bündelung (übernommen aus Extension v1.1.0 und erweitert).
 *
 * Modus "watchlist": Welche Verkäufer haben mehrere offene Watchlist-Karten? Ersparnis gegenüber
 *   dem Einzelkauf jeder Karte beim jeweils günstigsten Verkäufer (inkl. Porto).
 * Modus "deals": Regelkonforme Einzelangebote desselben Verkäufers zusammen kaufen → Porto wird
 *   geteilt, der Gewinn je Karte steigt.
 * Grundlage sind ausschließlich beobachtete Angebote. Ältere Beobachtungen werden markiert
 * ("vor dem Kauf prüfen"), weil Bestände sich inzwischen geändert haben können.
 */
import { shippingCost } from '../domain/shipping.ts';
import type { ObservedOffer } from '../domain/types.ts';
import { round2 } from '../util/num.ts';
import type { AppContext } from './context.ts';
import { listOffers } from './offers.ts';
import { listWatch, nameKey, offerMatchesEntry, type WatchEntry } from './watchlist.ts';
import { queryOpportunities } from './analysis.ts';

export interface BundleItem { key: string; name: string; need: number; copies: number; subtotal: number; condition: string | null; expansion: string | null; observedAt: string; stale: boolean }
export interface Bundle {
  seller: string; country: string | null; sellerType: string | null; sales: number | null;
  items: BundleItem[]; cards: number; copies: number; subtotal: number;
  shipping: { cost: number; tracked: boolean; domestic: boolean }; total: number;
  savings: number | null; stale: boolean; oldestObservation: string;
}

function takeCheapest(offers: ObservedOffer[], need: number) {
  const sorted = [...offers].sort((a, b) => a.price - b.price);
  let copies = 0, subtotal = 0;
  for (const o of sorted) {
    const n = Math.min(o.amount ?? 1, need - copies);
    copies += n;
    subtotal += n * o.price;
    if (copies >= need) break;
  }
  return { copies, subtotal: round2(subtotal) };
}

export function watchlistBundles(ctx: AppContext, maxAgeDays = 7) {
  const s = ctx.settings.get();
  const staleH = s.rules.maxOfferAgeHours;
  const now = Date.now();
  const active = listWatch(ctx.db).filter(e => !e.bought);
  const byKey = new Map<string, WatchEntry>(active.map(e => [e.nameKey, e]));
  const offers = listOffers(ctx.db, { maxAgeHours: maxAgeDays * 24, limit: 20000 });

  const sellers = new Map<string, { seller: string; country: string | null; sellerType: string | null; sales: number | null; items: Map<string, ObservedOffer[]> }>();
  const covered = new Set<string>();
  for (const o of offers) {
    if (!o.seller || (o.finish === 'foil' && !s.rules.includeFoil)) continue;
    const name = o.productName ?? '';
    const key = nameKey(name);
    const entry = byKey.get(key) ?? byKey.get(nameKey(name.split('//')[0]));
    if (!entry) continue;
    if (entry.productId != null && o.productId !== entry.productId) continue;
    if (entry.finish && o.finish !== entry.finish) continue;
    // Zustand/Sprache: Filter des Eintrags, sonst globale Kaufregeln
    if (!offerMatchesEntry(entry, o, s.rules.worstCondition, s.rules.allowedLanguages)) continue;
    covered.add(entry.nameKey);
    let sel = sellers.get(o.seller as string);
    if (!sel) { sel = { seller: o.seller as string, country: o.sellerCountry, sellerType: o.sellerType, sales: o.sellerSales, items: new Map() }; sellers.set(sel.seller, sel); }
    const list = sel.items.get(entry.nameKey) ?? [];
    list.push(o);
    sel.items.set(entry.nameKey, list);
  }

  function bestSingle(key: string, copies: number): number | null {
    let best: number | null = null;
    for (const sel of sellers.values()) {
      const offs = sel.items.get(key);
      if (!offs) continue;
      const t = takeCheapest(offs, copies);
      if (t.copies < copies) continue;
      const cost = t.subtotal + shippingCost(t.subtotal, sel.country, s.shipping).cost;
      if (best === null || cost < best) best = cost;
    }
    return best;
  }

  const bundles: Bundle[] = [];
  for (const sel of sellers.values()) {
    if (sel.items.size < 2) continue;
    const items: BundleItem[] = [];
    let subtotal = 0, single = 0, complete = true, oldest = new Date().toISOString();
    for (const [key, offs] of sel.items) {
      const entry = byKey.get(key) as WatchEntry;
      const t = takeCheapest(offs, entry.qty);
      const cheapest = [...offs].sort((a, b) => a.price - b.price)[0];
      if (cheapest.observedAt < oldest) oldest = cheapest.observedAt;
      const stale = (now - Date.parse(cheapest.observedAt)) / 36e5 > staleH;
      items.push({ key, name: entry.name, need: entry.qty, copies: t.copies, subtotal: t.subtotal, condition: cheapest.condition, expansion: cheapest.expansionName, observedAt: cheapest.observedAt, stale });
      subtotal += t.subtotal;
      const b = bestSingle(key, t.copies);
      if (b === null) complete = false; else single += b;
    }
    subtotal = round2(subtotal);
    const ship = shippingCost(subtotal, sel.country, s.shipping);
    const total = round2(subtotal + ship.cost);
    items.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    bundles.push({
      seller: sel.seller, country: sel.country, sellerType: sel.sellerType, sales: sel.sales, items,
      cards: items.length, copies: items.reduce((n, i) => n + i.copies, 0), subtotal,
      shipping: { cost: ship.cost, tracked: ship.tracked, domestic: ship.domestic }, total,
      savings: complete ? round2(single - total) : null, stale: items.some(i => i.stale), oldestObservation: oldest,
    });
  }
  const sv = (b: Bundle) => (b.savings == null ? -Infinity : b.savings);
  bundles.sort((a, b) => sv(b) - sv(a) || b.cards - a.cards || a.total - b.total);
  return { bundles, activeCount: active.length, coveredCount: covered.size, missing: active.filter(e => !covered.has(e.nameKey)).map(e => ({ id: e.id, name: e.name })) };
}

/** Regelkonforme bzw. empfohlene Einzelangebote nach Verkäufer gruppieren: geteiltes Porto erhöht den Gewinn. */
export function dealBundles(ctx: AppContext) {
  const s = ctx.settings.get();
  const res = queryOpportunities(ctx.db, { signalClass: 'LIVE_OFFER', limit: 2000 });
  const bySeller = new Map<string, typeof res.items>();
  for (const o of res.items) {
    if (!o.buy.seller || (o.scenarios.base?.profit ?? 0) <= 0) continue;
    const list = bySeller.get(o.buy.seller) ?? [];
    list.push(o);
    bySeller.set(o.buy.seller, list);
  }
  const out = [];
  for (const [seller, items] of bySeller) {
    if (items.length < 2) continue;
    const subtotal = round2(items.reduce((a, o) => a + o.buy.price, 0));
    const ship = shippingCost(subtotal, items[0].buy.sellerCountry, s.shipping);
    const singleShipping = round2(items.reduce((a, o) => a + o.buy.shipping, 0));
    const profitSingle = round2(items.reduce((a, o) => a + (o.scenarios.base?.profit ?? 0), 0));
    const savings = round2(singleShipping - ship.cost);
    out.push({
      seller, country: items[0].buy.sellerCountry, cards: items.length, subtotal,
      shipping: { cost: ship.cost, tracked: ship.tracked }, singleShipping, savings,
      profitSeparately: profitSingle, profitBundled: round2(profitSingle + savings),
      stale: items.some(o => (Date.now() - Date.parse(o.buy.observedAt)) / 36e5 > s.rules.maxOfferAgeHours),
      items: items.map(o => ({ key: o.key, name: o.name, setName: o.setName, price: o.buy.price, condition: o.buy.condition, observedAt: o.buy.observedAt, recommendation: o.recommendation })),
    });
  }
  out.sort((a, b) => b.profitBundled - a.profitBundled);
  return out;
}
