/**
 * Simulierte Angebote zum Testen von Bewertung, Alarmen und Dashboard.
 * Sie werden IMMER als SIMULATION gespeichert, im Dashboard markiert und nie an externe Kanäle gesendet.
 * Deterministisch (Seed), damit Testläufe reproduzierbar sind.
 */
import type { Db } from '../db/database.ts';
import type { OfferInput } from '../providers/types.ts';
import type { AppContext } from './context.ts';
import { ingestOffers, type IngestResult } from './offers.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSimulation(ctx: AppContext, count = 40, seed = 42): IngestResult & { note: string } {
  const s = ctx.settings.get();
  const rand = rng(seed);
  const products = ctx.db.all<{ external_id: number; name: string; set_name: string | null; finish: 'foil' | 'nonfoil'; trend: number }>(`
    SELECT p.external_id, p.name, p.set_name, l.finish, l.trend FROM price_latest l JOIN products p ON p.id = l.product_id
    WHERE l.trend BETWEEN ? AND ? AND l.avg30 IS NOT NULL ORDER BY (p.external_id * 2654435761) % 1000003 LIMIT ?`,
    [s.rules.minPrice, s.rules.maxPrice, count]);
  const conds = ['NM', 'NM', 'NM', 'EX', 'EX', 'GD', 'LP'];
  const langs = ['en', 'en', 'de', 'de', 'fr', 'it'];
  const countries = ['Deutschland', 'Deutschland', 'Österreich', 'Frankreich', 'Italien'];
  const offers: OfferInput[] = products.map((p, i) => ({
    externalId: `sim-${seed}-${i}`,
    productExternalId: p.external_id, productName: p.name, expansionName: p.set_name, finish: p.finish,
    price: Math.round(p.trend * (0.6 + rand() * 0.45) * 100) / 100,
    condition: conds[Math.floor(rand() * conds.length)], language: langs[Math.floor(rand() * langs.length)],
    seller: `SIM-Verkäufer-${1 + Math.floor(rand() * 8)}`, sellerCountry: countries[Math.floor(rand() * countries.length)],
    sellerType: rand() < 0.5 ? 'private' : 'pro', sellerSales: Math.floor(rand() * 5000), amount: 1 + Math.floor(rand() * 3),
    observedAt: new Date().toISOString(),
  }));
  const r = ingestOffers(ctx, 'simulation', 'SIMULATION', offers);
  return { ...r, note: `${offers.length} simulierte Angebote erzeugt (Seed ${seed}). Keine Kaufmöglichkeit.` };
}

export function clearSimulation(db: Db): number {
  return db.run("DELETE FROM offers WHERE signal_class = 'SIMULATION'").changes;
}
