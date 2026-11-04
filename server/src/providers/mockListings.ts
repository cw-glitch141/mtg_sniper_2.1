/**
 * Test-Feed für das Live-Radar. Liefert NUR simulierte Angebote (Signalklasse SIMULATION, Quelle
 * 'test:mock-feed', Verkäufer "TEST-…", Links auf example.invalid). Aktiv nur in Tests oder mit
 * MTGDS_MOCK_FEED=1 – niemals als Ersatz für einen echten Feed.
 *
 * Ablauf je Variante: Abfrage 1 = Grundlinie (zwei Angebote über Referenz),
 * Abfrage 2 = zusätzlich ein neues, günstiges Angebot und eine Preissenkung, ab Abfrage 3 unverändert.
 */
import { nowIso } from '../db/database.ts';
import { targetKey, type FetchListingsResult, type ListingProvider, type ListingRecord, type ListingTarget } from './listings.ts';

export const MOCK_FEED_ID = 'test:mock-feed';

export function mockListingProvider(referencePrice: (t: ListingTarget) => number | null): ListingProvider {
  const polls = new Map<string, number>();
  const rec = (t: ListingTarget, id: string, price: number, seller: string): ListingRecord => ({
    source: MOCK_FEED_ID, sourceAuthorized: false, productExternalId: t.externalId, targetKey: targetKey(t), finish: t.finish,
    listingId: id, seller, sellerCountry: 'DE', sellerType: 'professional', price: Math.round(price * 100) / 100, currency: 'EUR',
    condition: 'NM', language: 'en', quantity: 1, shipping: null,
    listingUrl: `https://example.invalid/test-listing/${id}`, sourceTimestamp: null, fetchedAt: nowIso(), expiresAt: null, flags: [],
  });
  return {
    id: MOCK_FEED_ID,
    label: 'TEST-Feed (Simulation)',
    kind: 'test',
    signalClass: 'SIMULATION',
    limits: 'keine (lokal)',
    coverage: 'Erfundene Testangebote für jede Zielvariante – keine Kaufmöglichkeit.',
    readiness: () => ({ configured: true, authorized: true, reason: null }),
    async fetchListings(targets, opts): Promise<FetchListingsResult> {
      const out: FetchListingsResult = { listings: [], covered: [], unsupported: [], requests: 0, rateLimited: false, errors: [] };
      for (const t of targets) {
        if (out.requests >= opts.budget) break;
        out.requests++;
        const ref = referencePrice(t);
        const key = targetKey(t);
        if (ref == null) { out.unsupported.push({ key, reason: 'kein Referenzpreis' }); continue; }
        const n = (polls.get(key) ?? 0) + 1;
        polls.set(key, n);
        const base = `${t.externalId}-${t.finish}`;
        out.listings.push(rec(t, `${base}-a`, ref * 1.08, 'TEST-Händler-A'));
        out.listings.push(rec(t, `${base}-b`, n >= 2 ? ref * 0.97 : ref * 1.15, 'TEST-Händler-B'));
        if (n >= 2) out.listings.push(rec(t, `${base}-c`, ref * 0.55, 'TEST-Händler-C'));
        out.covered.push(key);
      }
      return out;
    },
  };
}
