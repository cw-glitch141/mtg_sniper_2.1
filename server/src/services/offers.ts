/**
 * Beobachtete Einzelangebote (Extension, manueller Import, Simulation, künftig Live-API).
 * - Dubletten: (Quelle, externe ID) ist eindeutig. Ohne externe ID wird ein stabiler Schlüssel
 *   aus Produkt, Verkäufer, Zustand, Sprache, Finish und Preis gebildet.
 * - Preisänderungen: bei erneuter Beobachtung mit anderem Preis werden previous_price/price_changed_at gesetzt.
 * Strategie 1 (Unterbewertete Einzelangebote) bewertet jedes Angebot gegen die Referenz exakt derselben Variante.
 */
import { createHash } from 'node:crypto';
import { nowIso, type Db } from '../db/database.ts';
import { CONDITIONS, type Condition, type Finish, type ObservedOffer } from '../domain/types.ts';
import { buildOpportunity, type Opportunity } from '../analytics/opportunity.ts';
import type { OfferInput } from '../providers/types.ts';
import type { AppContext } from './context.ts';
import { getGuide, getHistory, getProduct, getProductByExternal } from './products.ts';
import { buildExposure } from './portfolio.ts';
import type { Exposure } from '../analytics/rules.ts';

const LANGS = ['en', 'de', 'fr', 'it', 'es', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht'];

export type OfferChange = 'new' | 'price_drop' | 'price_increase' | 'unchanged' | 'older_observation';

export interface IngestResult {
  inserted: number; updated: number; priceChanged: number; unmatched: number;
  rejected: { index: number; reason: string }[];
  offerIds: number[];
  items: { index: number; offerId: number }[];   // Zuordnung Eingabe-Index → gespeichertes Angebot
  changes: { index: number; offerId: number; change: OfferChange; oldPrice: number | null; newPrice: number }[];
}

export function normalizeCondition(c: unknown): Condition | null {
  const v = String(c ?? '').trim().toUpperCase();
  return (CONDITIONS as string[]).includes(v) ? (v as Condition) : null;
}

function validate(o: OfferInput): string | null {
  if (typeof o.price !== 'number' || !Number.isFinite(o.price) || o.price <= 0) return 'Preis fehlt oder ungültig';
  if (o.price > 100000) return 'Preis unplausibel hoch';
  if (o.productExternalId == null && !o.productName) return 'Produkt-ID oder Kartenname erforderlich';
  if (o.finish && o.finish !== 'foil' && o.finish !== 'nonfoil') return 'finish muss foil oder nonfoil sein';
  if (o.observedAt && !Number.isFinite(Date.parse(o.observedAt))) return 'observedAt ist kein gültiger Zeitstempel';
  // Keine stillschweigende Währungsumrechnung: alle Kalkulationen laufen in Euro.
  if (o.currency && o.currency.toUpperCase() !== 'EUR') return `Währung ${o.currency} wird nicht unterstützt (nur EUR, keine Umrechnung)`;
  if (o.shipping != null && (typeof o.shipping !== 'number' || !Number.isFinite(o.shipping) || o.shipping < 0)) return 'shipping muss eine nicht-negative Zahl sein';
  return null;
}

function stableKey(o: OfferInput, productKey: string): string {
  return 'h:' + createHash('sha1').update([productKey, o.seller ?? '', o.condition ?? '', o.language ?? '', o.finish ?? 'nonfoil', o.price.toFixed(2)].join('|')).digest('hex').slice(0, 20);
}

export function ingestOffers(ctx: AppContext, source: string, signalClass: 'LIVE_OFFER' | 'SIMULATION', offers: OfferInput[]): IngestResult {
  const { db } = ctx;
  const res: IngestResult = { inserted: 0, updated: 0, priceChanged: 0, unmatched: 0, rejected: [], offerIds: [], items: [], changes: [] };
  const track = (index: number, offerId: number) => { res.offerIds.push(offerId); res.items.push({ index, offerId }); };
  const now = nowIso();
  db.tx(() => {
    offers.forEach((o, index) => {
      const err = validate(o);
      if (err) { res.rejected.push({ index, reason: err }); return; }
      let product = o.productExternalId != null ? getProductByExternal(db, o.productExternalId) : null;
      if (!product && o.productName) {
        // Fallback über den Namen nur bei eindeutigem Treffer – sonst lieber unzugeordnet lassen.
        const hits = db.all<{ id: number }>('SELECT id FROM products WHERE name = ? COLLATE NOCASE' + (o.expansionName ? ' AND set_name = ? COLLATE NOCASE' : ''),
          o.expansionName ? [o.productName, o.expansionName] : [o.productName]);
        if (hits.length === 1) product = getProduct(db, hits[0].id);
      }
      if (!product) res.unmatched++;
      const lang = o.language && LANGS.includes(o.language.toLowerCase()) ? o.language.toLowerCase() : null;
      const ext = o.externalId ? String(o.externalId) : stableKey(o, String(o.productExternalId ?? o.productName));
      const observed = o.observedAt ? new Date(o.observedAt).toISOString() : now;
      const prev = db.get<{ id: number; price: number; observed_at: string }>('SELECT id, price, observed_at FROM offers WHERE source = ? AND external_id = ?', [source, ext]);
      const vals = {
        product_id: product?.id ?? null, product_external_id: o.productExternalId ?? product?.externalId ?? null,
        product_name: o.productName ?? product?.name ?? null, expansion_name: o.expansionName ?? product?.setName ?? null,
        finish: o.finish ?? 'nonfoil', condition: normalizeCondition(o.condition), language: lang,
        price: Math.round(o.price * 100) / 100, amount: o.amount ?? null, seller: o.seller ?? null,
        seller_country: o.sellerCountry ?? null, seller_type: o.sellerType ?? null, seller_sales: o.sellerSales ?? null,
        url: o.url ?? null, observed_at: observed, raw: JSON.stringify(o),
        currency: o.currency ? o.currency.toUpperCase() : null, shipping: o.shipping ?? null,
        source_timestamp: o.sourceTimestamp ?? null, fetched_at: o.fetchedAt ?? null, expires_at: o.expiresAt ?? null,
        source_authorized: o.sourceAuthorized == null ? null : o.sourceAuthorized ? 1 : 0,
        review_status: o.reviewStatus ?? null, review_reasons: o.reviewReasons?.length ? JSON.stringify(o.reviewReasons) : null,
      };
      if (!prev) {
        const r = db.run(`INSERT INTO offers (source, signal_class, external_id, product_id, product_external_id, product_name, expansion_name, finish,
            condition, language, price, amount, seller, seller_country, seller_type, seller_sales, url, first_seen_at, observed_at, raw,
            currency, shipping, source_timestamp, fetched_at, expires_at, source_authorized, review_status, review_reasons)
          VALUES (:source, :signal_class, :external_id, :product_id, :product_external_id, :product_name, :expansion_name, :finish,
            :condition, :language, :price, :amount, :seller, :seller_country, :seller_type, :seller_sales, :url, :observed_at, :observed_at, :raw,
            :currency, :shipping, :source_timestamp, :fetched_at, :expires_at, :source_authorized, :review_status, :review_reasons)`,
          { source, signal_class: signalClass, external_id: ext, ...vals });
        res.inserted++;
        track(index, r.lastInsertRowid);
        res.changes.push({ index, offerId: r.lastInsertRowid, change: 'new', oldPrice: null, newPrice: vals.price });
      } else {
        if (Date.parse(observed) < Date.parse(prev.observed_at)) { // ältere Beobachtung überschreibt nichts
          track(index, prev.id);
          res.changes.push({ index, offerId: prev.id, change: 'older_observation', oldPrice: prev.price, newPrice: prev.price });
          return;
        }
        const changed = Math.abs(prev.price - vals.price) >= 0.005;
        db.run(`UPDATE offers SET product_id = :product_id, product_external_id = :product_external_id, product_name = :product_name,
            expansion_name = :expansion_name, finish = :finish, condition = :condition, language = :language, price = :price, amount = :amount,
            seller = :seller, seller_country = :seller_country, seller_type = :seller_type, seller_sales = :seller_sales, url = :url,
            observed_at = :observed_at, raw = :raw, currency = :currency, shipping = :shipping, source_timestamp = :source_timestamp,
            fetched_at = :fetched_at, expires_at = :expires_at, source_authorized = :source_authorized,
            review_status = :review_status, review_reasons = :review_reasons,
            previous_price = CASE WHEN :changed = 1 THEN price ELSE previous_price END,
            price_changed_at = CASE WHEN :changed = 1 THEN :observed_at ELSE price_changed_at END
          WHERE id = :id`, { ...vals, changed: changed ? 1 : 0, id: prev.id });
        res.updated++;
        if (changed) res.priceChanged++;
        track(index, prev.id);
        res.changes.push({ index, offerId: prev.id, change: !changed ? 'unchanged' : vals.price < prev.price ? 'price_drop' : 'price_increase', oldPrice: prev.price, newPrice: vals.price });
      }
    });
  });
  return res;
}

interface OfferDbRow {
  id: number; source: string; signal_class: 'LIVE_OFFER' | 'SIMULATION'; external_id: string; product_id: number | null;
  product_name: string | null; expansion_name: string | null; finish: Finish; condition: Condition | null; language: string | null; price: number; amount: number | null;
  seller: string | null; seller_country: string | null; seller_type: string | null; seller_sales: number | null;
  url: string | null; observed_at: string; previous_price: number | null; first_seen_at: string;
  currency: string | null; shipping: number | null; source_timestamp: string | null; fetched_at: string | null; expires_at: string | null;
  source_authorized: number | null; review_status: string | null; review_reasons: string | null;
}

export function toOffer(r: OfferDbRow): ObservedOffer {
  let reasons: string[] = [];
  try { reasons = r.review_reasons ? JSON.parse(r.review_reasons) as string[] : []; } catch { reasons = []; }
  return {
    id: r.id, source: r.source, signalClass: r.signal_class, externalId: r.external_id, productId: r.product_id,
    productName: r.product_name, expansionName: r.expansion_name, finish: r.finish, condition: r.condition, language: r.language, price: r.price, amount: r.amount, seller: r.seller,
    sellerCountry: r.seller_country, sellerType: r.seller_type, sellerSales: r.seller_sales, url: r.url,
    observedAt: r.observed_at, previousPrice: r.previous_price, firstSeenAt: r.first_seen_at,
    currency: r.currency, shipping: r.shipping, sourceTimestamp: r.source_timestamp, fetchedAt: r.fetched_at, expiresAt: r.expires_at,
    sourceAuthorized: r.source_authorized == null ? null : r.source_authorized === 1,
    reviewStatus: r.review_status === 'review' ? 'review' : r.review_status === 'ok' ? 'ok' : null, reviewReasons: reasons,
  };
}

export function listOffers(db: Db, opts: { productId?: number; ids?: number[]; maxAgeHours?: number; includeSimulation?: boolean; limit?: number } = {}): ObservedOffer[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.productId != null) { where.push('product_id = ?'); params.push(opts.productId); }
  if (opts.ids?.length) { where.push(`id IN (${opts.ids.map(() => '?').join(',')})`); params.push(...opts.ids); }
  if (opts.maxAgeHours != null) { where.push('observed_at >= ?'); params.push(new Date(Date.now() - opts.maxAgeHours * 36e5).toISOString()); }
  if (!opts.includeSimulation) where.push("signal_class = 'LIVE_OFFER'");
  const sql = 'SELECT * FROM offers' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY observed_at DESC LIMIT ?';
  params.push(opts.limit ?? 500);
  return db.all<OfferDbRow>(sql, params).map(toOffer);
}

/** Strategie 1: ein beobachtetes Angebot gegen die Referenz derselben Variante bewerten. */
export function evaluateOffer(ctx: AppContext, offer: ObservedOffer, exposure?: Exposure): Opportunity | null {
  if (offer.productId == null) return null;
  const product = getProduct(ctx.db, offer.productId);
  if (!product) return null;
  const s = ctx.settings.get();
  return buildOpportunity({
    product, finish: offer.finish,
    guide: getGuide(ctx.db, product.id, offer.finish),
    history: getHistory(ctx.db, product.id, offer.finish, 45),
    strategy: 'underpriced_offer', signalClass: offer.signalClass,
    buy: {
      price: offer.price, shipping: offer.shipping ?? null, hypothetical: false,
      externalId: offer.externalId, reviewReasons: offer.reviewReasons ?? [],
      label: offer.signalClass === 'SIMULATION' ? (offer.source.startsWith('test:') ? 'TEST-Angebot (Simulation)' : 'Simuliertes Angebot') : `Einzelangebot${offer.seller ? ' von ' + offer.seller : ''}`,
      observedAt: offer.observedAt, source: offer.source, condition: offer.condition, language: offer.language,
      offerId: offer.id, offerUrl: offer.url, seller: offer.seller, sellerCountry: offer.sellerCountry,
      sellerType: offer.sellerType, sellerSales: offer.sellerSales, amount: offer.amount, previousPrice: offer.previousPrice,
    },
    triggers: offer.previousPrice != null && offer.previousPrice !== offer.price
      ? [`Preis geändert: vorher ${offer.previousPrice.toFixed(2)} €, jetzt ${offer.price.toFixed(2)} €.`] : [],
    exposure: exposure ?? buildExposure(ctx.db, s),
    now: Date.now(),
  }, s);
}

/** Einfacher CSV-Parser für den manuellen Angebotsimport (Trennzeichen ; oder , – erste Zeile = Spaltennamen). */
export function parseOfferCsv(text: string): { offers: OfferInput[]; errors: string[] } {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { offers: [], errors: ['CSV braucht eine Kopfzeile und mindestens eine Datenzeile.'] };
  const sep = lines[0].includes(';') ? ';' : ',';
  const split = (l: string) => {
    const out: string[] = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === sep && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(x => x.trim());
  };
  const head = split(lines[0]).map(h => h.toLowerCase());
  const col = (names: string[]) => head.findIndex(h => names.includes(h));
  const idx = {
    id: col(['idproduct', 'productid', 'product_id', 'cardmarket_id']), name: col(['name', 'card', 'karte']),
    set: col(['set', 'expansion', 'edition']), price: col(['price', 'preis']), cond: col(['condition', 'zustand']),
    lang: col(['language', 'sprache', 'lang']), foil: col(['foil', 'finish']), seller: col(['seller', 'verkäufer', 'verkaeufer']),
    country: col(['country', 'land']), url: col(['url', 'link']), amount: col(['amount', 'anzahl', 'qty']), at: col(['observedat', 'observed_at', 'zeitpunkt']),
  };
  if (idx.price === -1) return { offers: [], errors: ['Spalte "price"/"preis" fehlt.'] };
  if (idx.id === -1 && idx.name === -1) return { offers: [], errors: ['Spalte "idProduct" oder "name" fehlt.'] };
  const offers: OfferInput[] = [];
  const errors: string[] = [];
  lines.slice(1).forEach((l, i) => {
    const c = split(l);
    const get = (k: number) => (k === -1 ? '' : c[k] ?? '');
    const p = Number(get(idx.price).replace(/[€\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    if (!Number.isFinite(p) || p <= 0) { errors.push(`Zeile ${i + 2}: ungültiger Preis "${get(idx.price)}"`); return; }
    const foilRaw = get(idx.foil).toLowerCase();
    offers.push({
      productExternalId: get(idx.id) ? Number(get(idx.id)) : null,
      productName: get(idx.name) || null, expansionName: get(idx.set) || null, price: p,
      condition: get(idx.cond) || null, language: get(idx.lang) || null,
      finish: ['1', 'true', 'ja', 'yes', 'foil'].includes(foilRaw) ? 'foil' : 'nonfoil',
      seller: get(idx.seller) || null, sellerCountry: get(idx.country) || null, url: get(idx.url) || null,
      amount: get(idx.amount) ? Number(get(idx.amount)) : null, observedAt: get(idx.at) || null,
    });
  });
  return { offers, errors };
}
