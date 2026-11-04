/**
 * Datenbankmigrationen. Jede Migration läuft genau einmal (Tabelle schema_migrations).
 * Neue Migrationen NUR anhängen, bestehende nie ändern.
 *
 * Datenmodell (spielübergreifend):
 *   games → expansions → products (Produkt eines Anbieters, z. B. Cardmarket idProduct)
 *   Variante  = product + finish (nonfoil/foil) [+ Sprache/Zustand auf Angebotsebene]
 *   Preisserie = price_latest / price_snapshots je (product, finish, Quelle)
 *   Angebote  = offers (beobachtete Einzelangebote mit Signalklasse)
 */
import type { Db } from './database.ts';
import { migrateLegacyInventory } from './legacyInventory.ts';

/** sql läuft zuerst, danach optional up() für Datenmigrationen – beides in derselben Transaktion. */
export interface Migration { id: number; name: string; sql: string; up?: (db: Db) => void }

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE games (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
INSERT INTO games (id, name) VALUES ('mtg', 'Magic: The Gathering'), ('pokemon', 'Pokémon'), ('yugioh', 'Yu-Gi-Oh!');

CREATE TABLE expansions (
  game_id     TEXT NOT NULL REFERENCES games(id),
  source      TEXT NOT NULL,
  external_id INTEGER NOT NULL,
  code        TEXT,
  name        TEXT,
  released_at TEXT,
  PRIMARY KEY (game_id, source, external_id)
);

CREATE TABLE products (
  id                    INTEGER PRIMARY KEY,
  game_id               TEXT NOT NULL REFERENCES games(id),
  source                TEXT NOT NULL,
  external_id           INTEGER NOT NULL,
  product_type          TEXT NOT NULL DEFAULT 'single',
  name                  TEXT NOT NULL,
  expansion_external_id INTEGER,
  metacard_id           INTEGER,
  set_code              TEXT,
  set_name              TEXT,
  collector_number      TEXT,
  rarity                TEXT,
  image_url             TEXT,
  scryfall_id           TEXT,
  finishes              TEXT,
  mapping_status        TEXT NOT NULL DEFAULT 'unmapped',
  date_added            TEXT,
  updated_at            TEXT NOT NULL,
  UNIQUE (game_id, source, external_id)
);
CREATE INDEX products_name ON products (name COLLATE NOCASE);
CREATE INDEX products_metacard ON products (metacard_id);

CREATE TABLE price_latest (
  product_id        INTEGER NOT NULL REFERENCES products(id),
  finish            TEXT NOT NULL,
  source            TEXT NOT NULL,
  avg               REAL,
  low               REAL,
  trend             REAL,
  avg1              REAL,
  avg7              REAL,
  avg30             REAL,
  source_created_at TEXT NOT NULL,
  imported_at       TEXT NOT NULL,
  PRIMARY KEY (product_id, finish, source)
);
CREATE INDEX price_latest_trend ON price_latest (finish, trend);

CREATE TABLE price_snapshots (
  product_id        INTEGER NOT NULL,
  finish            TEXT NOT NULL,
  source            TEXT NOT NULL,
  snapshot_date     TEXT NOT NULL,
  avg               REAL,
  low               REAL,
  trend             REAL,
  avg1              REAL,
  avg7              REAL,
  avg30             REAL,
  source_created_at TEXT NOT NULL,
  PRIMARY KEY (product_id, finish, source, snapshot_date)
) WITHOUT ROWID;
CREATE INDEX price_snapshots_date ON price_snapshots (snapshot_date);

CREATE TABLE import_runs (
  id                 INTEGER PRIMARY KEY,
  source             TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  status             TEXT NOT NULL,
  rows_total         INTEGER,
  rows_written       INTEGER,
  source_created_at  TEXT,
  http_last_modified TEXT,
  http_etag          TEXT,
  message            TEXT
);
CREATE INDEX import_runs_source ON import_runs (source, started_at);

CREATE TABLE offers (
  id                  INTEGER PRIMARY KEY,
  source              TEXT NOT NULL,
  signal_class        TEXT NOT NULL CHECK (signal_class IN ('LIVE_OFFER', 'SIMULATION')),
  external_id         TEXT NOT NULL,
  product_id          INTEGER REFERENCES products(id),
  product_external_id INTEGER,
  product_name        TEXT,
  expansion_name      TEXT,
  finish              TEXT NOT NULL DEFAULT 'nonfoil',
  condition           TEXT,
  language            TEXT,
  price               REAL NOT NULL,
  amount              INTEGER,
  seller              TEXT,
  seller_country      TEXT,
  seller_type         TEXT,
  seller_sales        INTEGER,
  url                 TEXT,
  first_seen_at       TEXT NOT NULL,
  observed_at         TEXT NOT NULL,
  previous_price      REAL,
  price_changed_at    TEXT,
  raw                 TEXT,
  UNIQUE (source, external_id)
);
CREATE INDEX offers_product ON offers (product_id, observed_at);
CREATE INDEX offers_seller ON offers (seller);

CREATE TABLE watchlist (
  id           INTEGER PRIMARY KEY,
  list_name    TEXT NOT NULL DEFAULT 'Standard',
  game_id      TEXT NOT NULL DEFAULT 'mtg',
  name_key     TEXT NOT NULL,
  name         TEXT NOT NULL,
  product_id   INTEGER REFERENCES products(id),
  finish       TEXT,
  qty          INTEGER NOT NULL DEFAULT 1,
  target_price REAL,
  bought       INTEGER NOT NULL DEFAULT 0,
  url          TEXT,
  notes        TEXT,
  origin       TEXT NOT NULL DEFAULT 'dashboard',
  added_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX watchlist_unique ON watchlist (list_name, name_key, COALESCE(product_id, 0));

CREATE TABLE analysis_runs (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,
  candidates    INTEGER,
  opportunities INTEGER,
  data_date     TEXT,
  message       TEXT
);

CREATE TABLE opportunities (
  run_id         INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  rank           INTEGER NOT NULL,
  product_id     INTEGER,
  finish         TEXT,
  signal_class   TEXT NOT NULL,
  strategy       TEXT NOT NULL,
  score          REAL NOT NULL,
  confidence     REAL NOT NULL,
  profit_base    REAL,
  roi_base       REAL,
  recommendation TEXT NOT NULL,
  rules_passed   INTEGER NOT NULL,
  name           TEXT NOT NULL,
  set_name       TEXT,
  market_price   REAL,
  buy_price      REAL,
  sell_base      REAL,
  discount_pct   REAL,
  risk           TEXT,
  payload        TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
CREATE INDEX opportunities_rank ON opportunities (run_id, rank);

CREATE TABLE alerts (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  signal_class TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  product_id   INTEGER,
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  payload      TEXT,
  created_at   TEXT NOT NULL,
  read_at      TEXT,
  deliveries   TEXT
);
CREATE INDEX alerts_dedupe ON alerts (dedupe_key, created_at);
CREATE INDEX alerts_created ON alerts (created_at);

CREATE TABLE decisions (
  id                 INTEGER PRIMARY KEY,
  created_at         TEXT NOT NULL,
  opportunity_key    TEXT,
  product_id         INTEGER,
  signal_class       TEXT,
  strategy           TEXT,
  decision           TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  reason             TEXT,
  score              REAL,
  confidence         REAL,
  buy_price          REAL,
  expected_sell_base REAL,
  expected_profit_base REAL,
  payload            TEXT,
  inventory_id       INTEGER
);

CREATE TABLE inventory (
  id                 INTEGER PRIMARY KEY,
  product_id         INTEGER REFERENCES products(id),
  name               TEXT NOT NULL,
  set_name           TEXT,
  condition          TEXT,
  language           TEXT,
  finish             TEXT NOT NULL DEFAULT 'nonfoil',
  qty                INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 1),
  buy_price          REAL NOT NULL CHECK (buy_price >= 0),
  buy_shipping       REAL NOT NULL DEFAULT 0,
  buy_other_costs    REAL NOT NULL DEFAULT 0,
  buy_date           TEXT NOT NULL,
  seller             TEXT,
  buy_source         TEXT,
  status             TEXT NOT NULL CHECK (status IN ('ordered', 'delivered', 'listed', 'sold', 'returned')),
  list_price         REAL,
  listed_at          TEXT,
  sell_price         REAL,
  sell_date          TEXT,
  platform_fees      REAL,
  sell_shipping_cost REAL,
  sell_other_costs   REAL,
  decision_id        INTEGER REFERENCES decisions(id),
  notes              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX inventory_status ON inventory (status);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE saved_views (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  config     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: '2.1 business edition: purchases, stock lots, sales orders, capital ledger',
    sql: `
-- Lagerorte (mehrere Lager vorbereitet: warehouse)
CREATE TABLE locations (
  id          INTEGER PRIMARY KEY,
  warehouse   TEXT NOT NULL DEFAULT 'HAUPT',
  code        TEXT NOT NULL,
  description TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  UNIQUE (warehouse, code)
);

-- Einkaufsaufträge (Kauf ≠ Zahlung ≠ Lieferung)
CREATE TABLE purchase_orders (
  id            INTEGER PRIMARY KEY,
  supplier      TEXT,
  platform      TEXT NOT NULL DEFAULT 'cardmarket',
  external_ref  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('planned','ordered','paid','partially_received','received','cancelled','problem','returned')),
  vat_treatment TEXT NOT NULL DEFAULT 'none' CHECK (vat_treatment IN ('none','vat_invoice','margin_scheme')),
  vat_rate_pct  REAL NOT NULL DEFAULT 19,
  shipping_cost REAL NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
  other_costs   REAL NOT NULL DEFAULT 0 CHECK (other_costs >= 0),
  refund_amount REAL NOT NULL DEFAULT 0,
  ordered_at    TEXT,
  paid_at       TEXT,
  received_at   TEXT,
  problem_note  TEXT,
  notes         TEXT,
  actor         TEXT NOT NULL DEFAULT 'owner',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX purchase_orders_status ON purchase_orders (status);

CREATE TABLE purchase_lines (
  id               INTEGER PRIMARY KEY,
  po_id            INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  game_id          TEXT NOT NULL DEFAULT 'mtg',
  product_id       INTEGER REFERENCES products(id),
  name             TEXT NOT NULL,
  set_name         TEXT,
  finish           TEXT NOT NULL DEFAULT 'nonfoil',
  condition        TEXT,
  language         TEXT,
  qty              INTEGER NOT NULL CHECK (qty >= 1),
  unit_price       REAL NOT NULL CHECK (unit_price >= 0),
  received_qty     INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  decision_id      INTEGER REFERENCES decisions(id),
  opportunity_key  TEXT,
  CHECK (received_qty <= qty)
);
CREATE INDEX purchase_lines_po ON purchase_lines (po_id);
CREATE INDEX purchase_lines_product ON purchase_lines (product_id);

-- Bestandsposten (Charge): ein Wareneingang einer Variante zu einem Einstandspreis
CREATE TABLE stock_lots (
  id                   INTEGER PRIMARY KEY,
  game_id              TEXT NOT NULL DEFAULT 'mtg',
  product_id           INTEGER REFERENCES products(id),
  name                 TEXT NOT NULL,
  set_name             TEXT,
  set_code             TEXT,
  collector_number     TEXT,
  finish               TEXT NOT NULL DEFAULT 'nonfoil',
  condition            TEXT,
  language             TEXT,
  ownership            TEXT NOT NULL DEFAULT 'business' CHECK (ownership IN ('business','private')),
  private_deck         TEXT,
  qty_received         INTEGER NOT NULL CHECK (qty_received >= 0),
  qty_on_hand          INTEGER NOT NULL CHECK (qty_on_hand >= 0),
  qty_reserved         INTEGER NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  qty_sold             INTEGER NOT NULL DEFAULT 0 CHECK (qty_sold >= 0),
  unit_cost            REAL NOT NULL CHECK (unit_cost >= 0),
  allocated_cost_total REAL NOT NULL DEFAULT 0 CHECK (allocated_cost_total >= 0),
  vat_treatment        TEXT NOT NULL DEFAULT 'none',
  vat_rate_pct         REAL NOT NULL DEFAULT 19,
  purchase_line_id     INTEGER REFERENCES purchase_lines(id),
  acquired_at          TEXT NOT NULL,
  received_at          TEXT NOT NULL,
  location_id          INTEGER REFERENCES locations(id),
  list_price           REAL,
  list_platform        TEXT,
  listed_at            TEXT,
  min_price_override   REAL,
  notes                TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (qty_reserved <= qty_on_hand)
);
CREATE INDEX stock_lots_product ON stock_lots (product_id, finish);
CREATE INDEX stock_lots_location ON stock_lots (location_id);
CREATE INDEX stock_lots_ownership ON stock_lots (ownership, qty_on_hand);

-- Lückenloses Bewegungsprotokoll je Charge
CREATE TABLE stock_movements (
  id         INTEGER PRIMARY KEY,
  lot_id     INTEGER NOT NULL REFERENCES stock_lots(id),
  type       TEXT NOT NULL CHECK (type IN ('receive','reserve','release','ship','return','adjust','writeoff','transfer','move')),
  qty        INTEGER NOT NULL,
  ref_type   TEXT,
  ref_id     INTEGER,
  note       TEXT,
  actor      TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL
);
CREATE INDEX stock_movements_lot ON stock_movements (lot_id, created_at);

-- Verkaufsaufträge
CREATE TABLE sales_orders (
  id                INTEGER PRIMARY KEY,
  platform          TEXT NOT NULL DEFAULT 'cardmarket',
  external_order_id TEXT,
  buyer             TEXT,
  buyer_country     TEXT,
  ship_address      TEXT,
  status            TEXT NOT NULL CHECK (status IN ('new','checked','picking','packed','shipped','completed','cancelled','returned','problem')),
  payment_status    TEXT NOT NULL DEFAULT 'open' CHECK (payment_status IN ('open','received','refunded')),
  priority          INTEGER NOT NULL DEFAULT 0,
  shipping_charged  REAL NOT NULL DEFAULT 0 CHECK (shipping_charged >= 0),
  shipping_cost     REAL CHECK (shipping_cost >= 0),
  packaging_cost    REAL CHECK (packaging_cost >= 0),
  platform_fee      REAL CHECK (platform_fee >= 0),
  payment_fee       REAL CHECK (payment_fee >= 0),
  other_costs       REAL CHECK (other_costs >= 0),
  refund_amount     REAL NOT NULL DEFAULT 0,
  carrier           TEXT,
  tracking_number   TEXT,
  ordered_at        TEXT NOT NULL,
  paid_at           TEXT,
  shipped_at        TEXT,
  completed_at      TEXT,
  status_before_problem TEXT,
  problem_note      TEXT,
  notes             TEXT,
  archived          INTEGER NOT NULL DEFAULT 0,
  actor             TEXT NOT NULL DEFAULT 'owner',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX sales_orders_external ON sales_orders (platform, external_order_id) WHERE external_order_id IS NOT NULL;
CREATE INDEX sales_orders_status ON sales_orders (status, archived);

CREATE TABLE sales_order_lines (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id  INTEGER REFERENCES products(id),
  name        TEXT NOT NULL,
  set_name    TEXT,
  finish      TEXT NOT NULL DEFAULT 'nonfoil',
  condition   TEXT,
  language    TEXT,
  qty         INTEGER NOT NULL CHECK (qty >= 1),
  unit_price  REAL NOT NULL CHECK (unit_price >= 0),
  missing_qty INTEGER NOT NULL DEFAULT 0,
  returned_qty INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sales_order_lines_order ON sales_order_lines (order_id);

-- Zuordnung Auftragsposition → Charge (Reservierung, Versand, Rückgabe)
CREATE TABLE sales_allocations (
  id            INTEGER PRIMARY KEY,
  line_id       INTEGER NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
  lot_id        INTEGER NOT NULL REFERENCES stock_lots(id),
  qty           INTEGER NOT NULL CHECK (qty >= 1),
  status        TEXT NOT NULL CHECK (status IN ('reserved','shipped','released','returned')),
  returned_qty  INTEGER NOT NULL DEFAULT 0,
  restocked_qty INTEGER NOT NULL DEFAULT 0,
  unit_cost     REAL NOT NULL,
  unit_alloc    REAL NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX sales_allocations_line ON sales_allocations (line_id);
CREATE INDEX sales_allocations_lot ON sales_allocations (lot_id, status);

-- Kapitalbuch (Einlagen, Entnahmen, laufende Kosten, Steuerzahlungen, Korrekturen)
CREATE TABLE capital_ledger (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','expense','tax_payment','adjustment')),
  amount     REAL NOT NULL,
  booked_at  TEXT NOT NULL,
  category   TEXT,
  note       TEXT,
  actor      TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL
);

-- Jede Kaufempfehlung wird einmalig protokolliert (für die Strategievalidierung)
CREATE TABLE recommendation_log (
  key              TEXT PRIMARY KEY,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  product_id       INTEGER,
  finish           TEXT,
  signal_class     TEXT NOT NULL,
  strategy         TEXT NOT NULL,
  recommendation   TEXT NOT NULL,
  priority         TEXT,
  score            REAL,
  confidence       REAL,
  buy_price        REAL,
  expected_sell    REAL,
  expected_profit  REAL,
  reference_price  REAL,
  discount_pct     REAL,
  rarity           TEXT,
  set_name         TEXT
);

-- Täglicher Bestandswert (Einstand vs. Marktwert-Schätzung)
CREATE TABLE portfolio_snapshots (
  snapshot_date  TEXT PRIMARY KEY,
  units          INTEGER NOT NULL,
  cost_value     REAL NOT NULL,
  market_value   REAL,
  market_covered INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);

ALTER TABLE alerts ADD COLUMN priority TEXT;
ALTER TABLE opportunities ADD COLUMN priority TEXT;
ALTER TABLE decisions ADD COLUMN purchase_line_id INTEGER;
ALTER TABLE watchlist ADD COLUMN min_condition TEXT;
ALTER TABLE watchlist ADD COLUMN languages TEXT;
`,
    up: migrateLegacyInventory,
  },
  {
    id: 3,
    name: '2.2 live-deal-radar: listing feeds, offer events, poll runs, quality reports',
    // Nur additive Änderungen: bestehende Tabellen und Nutzerdaten bleiben unverändert.
    sql: `
ALTER TABLE offers ADD COLUMN currency TEXT;
ALTER TABLE offers ADD COLUMN shipping REAL;
ALTER TABLE offers ADD COLUMN source_timestamp TEXT;
ALTER TABLE offers ADD COLUMN fetched_at TEXT;
ALTER TABLE offers ADD COLUMN expires_at TEXT;
ALTER TABLE offers ADD COLUMN source_authorized INTEGER;
ALTER TABLE offers ADD COLUMN review_status TEXT;
ALTER TABLE offers ADD COLUMN review_reasons TEXT;

-- Neue oder preisreduzierte Angebote, die ein Listing-Feed erkannt hat
CREATE TABLE offer_events (
  id            INTEGER PRIMARY KEY,
  offer_id      INTEGER NOT NULL REFERENCES offers(id),
  source        TEXT NOT NULL,
  signal_class  TEXT NOT NULL,
  event_type    TEXT NOT NULL CHECK (event_type IN ('new_listing', 'price_drop', 'price_increase')),
  old_price     REAL,
  new_price     REAL NOT NULL,
  detected_at   TEXT NOT NULL,
  latency_ms    INTEGER,
  latency_basis TEXT,
  alert_id      INTEGER,
  run_id        INTEGER
);
CREATE INDEX offer_events_detected ON offer_events (detected_at);

-- Jede Abfrage eines Listing-Feeds (Health, Rate-Limits, Abdeckung, Fehler)
CREATE TABLE live_poll_runs (
  id            INTEGER PRIMARY KEY,
  provider      TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed', 'not_ready')),
  targets       INTEGER NOT NULL DEFAULT 0,
  covered       INTEGER NOT NULL DEFAULT 0,
  unsupported   INTEGER NOT NULL DEFAULT 0,
  requests      INTEGER NOT NULL DEFAULT 0,
  listings      INTEGER NOT NULL DEFAULT 0,
  accepted      INTEGER NOT NULL DEFAULT 0,
  review        INTEGER NOT NULL DEFAULT 0,
  rejected      INTEGER NOT NULL DEFAULT 0,
  new_listings  INTEGER NOT NULL DEFAULT 0,
  price_drops   INTEGER NOT NULL DEFAULT 0,
  alerts        INTEGER NOT NULL DEFAULT 0,
  rate_limited  INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  message       TEXT
);
CREATE INDEX live_poll_runs_provider ON live_poll_runs (provider, started_at);

-- Überwachte Varianten je Feed; first_polled_at = Grundlinie (erste Abfrage erzeugt keine Alarme)
CREATE TABLE listing_targets (
  provider        TEXT NOT NULL,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  finish          TEXT NOT NULL,
  priority        REAL NOT NULL DEFAULT 0,
  reasons         TEXT,
  selected_at     TEXT NOT NULL,
  first_polled_at TEXT,
  last_polled_at  TEXT,
  last_ok_at      TEXT,
  last_listings   INTEGER,
  unsupported     TEXT,
  PRIMARY KEY (provider, product_id, finish)
);

-- Zuordnung Anbieter-Produkt (z. B. CardTrader-Blueprint) → Cardmarket-idProduct
CREATE TABLE provider_product_map (
  provider            TEXT NOT NULL,
  product_external_id INTEGER NOT NULL,
  provider_product_id TEXT NOT NULL,
  provider_group_id   TEXT,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (provider, product_external_id, provider_product_id)
);
CREATE TABLE provider_group_sync (
  provider   TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  synced_at  TEXT NOT NULL,
  items      INTEGER NOT NULL,
  PRIMARY KEY (provider, group_id)
);

-- Täglicher Qualitätsbericht (für Trends)
CREATE TABLE quality_reports (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  status     TEXT NOT NULL,
  summary    TEXT NOT NULL,
  report     TEXT NOT NULL
);
`,
  },
];
