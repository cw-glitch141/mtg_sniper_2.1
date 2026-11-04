import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'MTG Deal Sniper 2.2 – Business Edition';
export const APP_VERSION = '2.2.0';
export const USER_AGENT = 'MTGDealSniper/2.2 (local, private use)';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Umgebungsvariablen aus .env im Projektordner laden (falls vorhanden). Secrets gehören NUR dorthin. */
export function loadEnv(): void {
  const envFile = join(ROOT_DIR, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export interface RuntimeConfig {
  dataDir: string;
  dbFile: string;
  rawDir: string;
  logFile: string;
  host: string;
  port: number;
  webDist: string;
  schedulerEnabled: boolean;
  secrets: {
    telegramBotToken: string | null;
    telegramChatId: string | null;
    discordWebhookUrl: string | null;
    /** Eigenes CardTrader-API-Token des Besitzers (Profil → Einstellungen). Nie fremde Tokens verwenden. */
    cardtraderToken: string | null;
  };
  /** Nur für Tests/Demo: simulierter Listing-Feed, alle Ergebnisse als SIMULATION/TEST gekennzeichnet. */
  mockListingFeed: boolean;
  sources: {
    priceGuideUrl: string;
    productListUrl: string;
    scryfallBulkUrl: string;
  };
}

export function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const env = process.env;
  const dataDir = resolve(overrides.dataDir ?? env.MTGDS_DATA_DIR ?? join(ROOT_DIR, 'data'));
  mkdirSync(dataDir, { recursive: true });
  const cfg: RuntimeConfig = {
    dataDir,
    dbFile: join(dataDir, 'mtgds.sqlite'),
    rawDir: join(dataDir, 'raw'),
    logFile: join(dataDir, 'logs', 'app.log'),
    // Nur lokal erreichbar. Bewusst kein 0.0.0.0: das Dashboard soll nicht im Netzwerk hängen.
    host: env.MTGDS_HOST ?? '127.0.0.1',
    port: Number(env.MTGDS_PORT ?? 8787),
    webDist: join(ROOT_DIR, 'web', 'dist'),
    schedulerEnabled: env.MTGDS_SCHEDULER !== 'off',
    secrets: {
      telegramBotToken: env.TELEGRAM_BOT_TOKEN || null,
      telegramChatId: env.TELEGRAM_CHAT_ID || null,
      discordWebhookUrl: env.DISCORD_WEBHOOK_URL || null,
      cardtraderToken: env.CARDTRADER_TOKEN || null,
    },
    mockListingFeed: env.MTGDS_MOCK_FEED === '1',
    sources: {
      priceGuideUrl: env.MTGDS_PRICE_GUIDE_URL ?? 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json',
      productListUrl: env.MTGDS_PRODUCT_LIST_URL ?? 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_1.json',
      scryfallBulkUrl: env.MTGDS_SCRYFALL_BULK_URL ?? 'https://api.scryfall.com/bulk-data/default-cards',
    },
    ...overrides,
  };
  mkdirSync(cfg.rawDir, { recursive: true });
  return cfg;
}
