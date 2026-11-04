/**
 * Öffentliche Cardmarket-Dateien (downloads.s3.cardmarket.com).
 * Format verifiziert am 04.11.2026:
 *   price_guide_1.json:     { version, createdAt, priceGuides: [{ idProduct, idCategory, avg, low, trend, avg1, avg7, avg30, "avg-foil", … }] }
 *   products_singles_1.json:{ version, createdAt, products: [{ idProduct, name, idCategory, categoryName, idExpansion, idMetacard, dateAdded }] }
 * Der Price Guide wird einmal täglich (nachts) erzeugt. Er enthält aggregierte Werte, KEINE einzelnen Angebote.
 */
import { price } from '../util/num.ts';
import { getJson, type Conditional } from './http.ts';
import type { CatalogProduct, CatalogProvider, Fetched, PriceProvider, PriceRow } from './types.ts';

interface RawGuide { version?: number; createdAt?: string; priceGuides?: Record<string, unknown>[] }
interface RawProducts { version?: number; createdAt?: string; products?: Record<string, unknown>[] }

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

export function parsePriceGuide(data: RawGuide): { createdAt: string; items: PriceRow[] } {
  if (!data || !Array.isArray(data.priceGuides) || typeof data.createdAt !== 'string') {
    throw new Error('Price Guide hat ein unerwartetes Format (priceGuides/createdAt fehlen).');
  }
  const items: PriceRow[] = [];
  for (const r of data.priceGuides) {
    const id = int(r.idProduct);
    if (id == null) continue;
    items.push({
      externalId: id,
      categoryId: int(r.idCategory),
      nonfoil: { avg: price(r.avg), low: price(r.low), trend: price(r.trend), avg1: price(r.avg1), avg7: price(r.avg7), avg30: price(r.avg30) },
      foil: {
        avg: price(r['avg-foil']), low: price(r['low-foil']), trend: price(r['trend-foil']),
        avg1: price(r['avg1-foil']), avg7: price(r['avg7-foil']), avg30: price(r['avg30-foil']),
      },
    });
  }
  return { createdAt: data.createdAt, items };
}

export function parseProductList(data: RawProducts): { createdAt: string; items: CatalogProduct[] } {
  if (!data || !Array.isArray(data.products) || typeof data.createdAt !== 'string') {
    throw new Error('Produktkatalog hat ein unerwartetes Format (products/createdAt fehlen).');
  }
  const items: CatalogProduct[] = [];
  for (const p of data.products) {
    const id = int(p.idProduct);
    if (id == null || typeof p.name !== 'string' || !p.name.trim()) continue;
    items.push({
      externalId: id,
      name: p.name.trim(),
      expansionExternalId: int(p.idExpansion),
      metacardId: int(p.idMetacard),
      dateAdded: typeof p.dateAdded === 'string' ? p.dateAdded : null,
    });
  }
  return { createdAt: data.createdAt, items };
}

export function cardmarketCatalog(url: string): CatalogProvider {
  return {
    id: 'cardmarket_catalog',
    gameId: 'mtg',
    async fetchCatalog(cond?: Conditional): Promise<Fetched<CatalogProduct>> {
      const r = await getJson<RawProducts>(url, cond);
      if (r.notModified) return r;
      const p = parseProductList(r.data);
      return { notModified: false, meta: r.meta, createdAt: p.createdAt, items: p.items, raw: r.text };
    },
  };
}

export function cardmarketPriceGuide(url: string): PriceProvider {
  return {
    id: 'cardmarket_price_guide',
    gameId: 'mtg',
    checkUrl: url,
    async fetchPrices(cond?: Conditional): Promise<Fetched<PriceRow>> {
      const r = await getJson<RawGuide>(url, cond);
      if (r.notModified) return r;
      const p = parsePriceGuide(r.data);
      return { notModified: false, meta: r.meta, createdAt: p.createdAt, items: p.items, raw: r.text };
    },
  };
}
