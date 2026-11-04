import type { RuntimeConfig } from '../config.ts';
import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import { DEFAULT_SETTINGS, mergeSettings, type AppSettings } from '../domain/settings.ts';
import { cardmarketCatalog, cardmarketPriceGuide } from '../providers/cardmarketS3.ts';
import { cardtraderProvider } from '../providers/cardtrader.ts';
import type { ListingProvider } from '../providers/listings.ts';
import { mockListingProvider } from '../providers/mockListings.ts';
import type { CatalogProvider, PriceProvider } from '../providers/types.ts';

export interface Providers {
  catalog: CatalogProvider;
  prices: PriceProvider;
  scryfallBulkUrl: string;
  /**
   * Angebotsgenaue Feeds. Registriert heißt nicht angeschlossen: jeder Feed meldet über readiness(),
   * ob Token und Freigabe des Besitzers vorliegen. Eine Cardmarket-API ist nicht enthalten (keine Zulassung).
   */
  listings: ListingProvider[];
}

export class SettingsStore {
  private cache: AppSettings | null = null;
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(): AppSettings {
    if (this.cache) return this.cache;
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'app'");
    let s = structuredClone(DEFAULT_SETTINGS);
    if (row) {
      // Gespeicherte Werte über die Standardwerte legen (neue Schlüssel aus Updates erhalten so ihren Standard).
      const merged = mergeSettings(s, JSON.parse(row.value));
      s = merged.settings;
    }
    this.cache = s;
    return s;
  }

  update(patch: unknown): { settings: AppSettings; errors: string[] } {
    const { settings, errors } = mergeSettings(this.get(), patch);
    if (errors.length) return { settings: this.get(), errors };
    this.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [JSON.stringify(settings), nowIso()]);
    this.cache = settings;
    return { settings, errors: [] };
  }

  reset(): AppSettings {
    this.db.run("DELETE FROM settings WHERE key = 'app'");
    this.cache = null;
    return this.get();
  }
}

export interface AppContext {
  db: Db;
  cfg: RuntimeConfig;
  settings: SettingsStore;
  providers: Providers;
}

export function createContext(db: Db, cfg: RuntimeConfig, providers?: Partial<Providers>): AppContext {
  const settings = new SettingsStore(db);
  const defaultListings = (): ListingProvider[] => {
    const list: ListingProvider[] = [cardtraderProvider({ db, token: () => cfg.secrets.cardtraderToken, settings: () => settings.get().live.cardtrader })];
    if (cfg.mockListingFeed) {
      list.push(mockListingProvider(t => db.get<{ trend: number | null }>(
        "SELECT trend FROM price_latest WHERE product_id = ? AND finish = ? AND source = 'cardmarket_price_guide'", [t.productId, t.finish])?.trend ?? null));
    }
    return list;
  };
  return {
    db, cfg, settings,
    providers: {
      catalog: providers?.catalog ?? cardmarketCatalog(cfg.sources.productListUrl),
      prices: providers?.prices ?? cardmarketPriceGuide(cfg.sources.priceGuideUrl),
      scryfallBulkUrl: providers?.scryfallBulkUrl ?? cfg.sources.scryfallBulkUrl,
      listings: providers?.listings ?? defaultListings(),
    },
  };
}
