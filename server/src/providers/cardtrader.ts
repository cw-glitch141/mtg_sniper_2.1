/**
 * CardTrader-Listing-Adapter (offizielle REST-API v2, https://api.cardtrader.com/api/v2).
 *
 * Grundlage (Stand der Recherche, siehe docs/datenquellen.md):
 *   - Authentifizierung: "Authorization: Bearer <Token>" – das Token stammt aus dem EIGENEN CardTrader-Profil.
 *   - GET /marketplace/products?blueprint_id=… liefert ein Objekt {blueprintId: [Angebote]} mit bis zu
 *     25 günstigsten Angeboten je Blueprint (Preis in Cent, Zustand, Sprache, Foil, Verkäufer, Land).
 *   - Blueprints tragen card_market_ids → exakte Zuordnung zur Cardmarket-Druckvariante.
 *   - Dokumentierte Limits laut Drittquellen: 200 Anfragen / 10 s gesamt, Marketplace 10 Anfragen / s.
 * Die offizielle Referenz war für automatische Abrufe gesperrt (HTTP 403). Feldnamen und Limits sind daher
 * beim ersten echten Lauf zu bestätigen – bis dahin gilt der Adapter als "implementiert, nicht verifiziert".
 *
 * Bewusst NICHT enthalten: Kauf-, Warenkorb- oder Bestellfunktionen. Der Adapter liest nur.
 */
import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { AppSettings } from '../domain/settings.ts';
import { USER_AGENT } from '../config.ts';
import { mapCondition, targetKey, type FetchListingsResult, type ListingProvider, type ListingRecord, type ListingTarget } from './listings.ts';

export const CARDTRADER_ID = 'api:cardtrader';
const BASE = 'https://api.cardtrader.com/api/v2';
const MTG_GAME_ID = 1;

const LANG: Record<string, string> = { jp: 'ja', ja: 'ja', kr: 'ko', ko: 'ko', 'zh-cn': 'zhs', 'zh-tw': 'zht', zhs: 'zhs', zht: 'zht' };
export const mapLanguage = (raw: unknown): string | null => {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  return LANG[v] ?? (/^[a-z]{2}$/.test(v) ? v : null);
};

class StopRun extends Error {}

interface CtExpansion { id: number; game_id: number; code: string; name: string }
interface CtBlueprint { id: number; game_id?: number; expansion_id?: number; card_market_ids?: number[] | null }
interface CtProduct {
  id: number; blueprint_id: number; quantity?: number; bundle_size?: number; graded?: boolean; on_vacation?: boolean;
  price?: { cents?: number; currency?: string } | null; price_cents?: number; price_currency?: string;
  properties_hash?: { condition?: string; mtg_language?: string; mtg_foil?: boolean; signed?: boolean; altered?: boolean } | null;
  user?: { username?: string; country_code?: string; user_type?: string } | null;
}

export interface CardTraderDeps {
  db: Db;
  token: () => string | null;
  settings: () => AppSettings['live']['cardtrader'];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Ein Marketplace-Angebot in das allgemeine Listing-Format übersetzen. */
export function mapCardTraderProduct(p: CtProduct, target: ListingTarget, urlTemplate: string, fetchedAt: string): ListingRecord {
  const props = p.properties_hash ?? {};
  const cents = p.price?.cents ?? p.price_cents;
  const flags: string[] = [];
  if (props.signed) flags.push('signiert');
  if (props.altered) flags.push('verändert (altered)');
  if (p.graded) flags.push('gegradet');
  if (p.on_vacation) flags.push('Verkäufer im Urlaub');
  if ((p.bundle_size ?? 1) > 1) flags.push(`Bündel zu ${p.bundle_size} Stück`);
  return {
    source: CARDTRADER_ID, sourceAuthorized: true,
    productExternalId: target.externalId, targetKey: targetKey(target),
    finish: typeof props.mtg_foil === 'boolean' ? (props.mtg_foil ? 'foil' : 'nonfoil') : null,
    listingId: p.id != null ? String(p.id) : null,
    seller: p.user?.username ?? null, sellerCountry: p.user?.country_code ?? null, sellerType: p.user?.user_type ?? null,
    price: typeof cents === 'number' && Number.isFinite(cents) ? cents / 100 : null,
    currency: p.price?.currency ?? p.price_currency ?? null,
    condition: mapCondition(props.condition), language: mapLanguage(props.mtg_language),
    quantity: p.quantity ?? null, shipping: null,
    listingUrl: urlTemplate.replace('{blueprint_id}', String(p.blueprint_id)).replace('{listing_id}', String(p.id)),
    sourceTimestamp: null, fetchedAt, expiresAt: null, flags,
  };
}

export function cardtraderProvider(deps: CardTraderDeps): ListingProvider {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  let expansions: { at: number; byCode: Map<string, CtExpansion> } | null = null;

  return {
    id: CARDTRADER_ID,
    label: 'CardTrader API (eigenes Token)',
    kind: 'licensed_api',
    signalClass: 'LIVE_OFFER',
    limits: 'laut Dokumentation: 200 Anfragen je 10 s gesamt, Marketplace 10 Anfragen/s – Adapter nutzt höchstens die eingestellte Rate (Standard 4/s)',
    coverage: 'Nur der CardTrader-Marktplatz (nicht Cardmarket). Je Variante die bis zu 25 günstigsten Angebote. Kein Porto je Angebot (wird geschätzt), kein Angebots-Deeplink (Link führt zur Kartenseite).',
    readiness() {
      const s = deps.settings();
      if (!deps.token()) return { configured: false, authorized: false, reason: 'Kein CARDTRADER_TOKEN in .env (eigenes Token aus dem CardTrader-Profil).' };
      if (!s.enabled) return { configured: true, authorized: false, reason: 'In den Einstellungen deaktiviert (live.cardtrader.enabled).' };
      if (!s.termsConfirmed) return { configured: true, authorized: false, reason: 'Nutzungsbedingungen der CardTrader-API noch nicht bestätigt (live.cardtrader.termsConfirmed).' };
      return { configured: true, authorized: true, reason: null };
    },

    async fetchListings(targets, opts): Promise<FetchListingsResult> {
      const s = deps.settings();
      const token = deps.token();
      const out: FetchListingsResult = { listings: [], covered: [], unsupported: [], requests: 0, rateLimited: false, errors: [] };
      if (!token) { out.errors.push('Kein Token'); return out; }
      const minGap = 1000 / Math.max(0.1, Math.min(10, s.maxRequestsPerSecond));
      let last = 0;

      const call = async <T>(path: string): Promise<T> => {
        if (out.requests >= opts.budget) throw new StopRun('Anfrage-Budget dieses Laufs erschöpft');
        const wait = last + minGap - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        out.requests++;
        const res = await doFetch(BASE + path, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
          signal: opts.signal ?? AbortSignal.timeout(20_000),
        });
        if (res.status === 429) { out.rateLimited = true; throw new StopRun('Rate-Limit erreicht (HTTP 429) – Lauf abgebrochen'); }
        if (res.status === 401 || res.status === 403) throw new StopRun(`Zugriff verweigert (HTTP ${res.status}) – Token prüfen`);
        if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
        return await res.json() as T;
      };

      const blueprintsFor = (externalId: number) => deps.db.all<{ provider_product_id: string }>(
        'SELECT provider_product_id FROM provider_product_map WHERE provider = ? AND product_external_id = ?', [CARDTRADER_ID, externalId]).map(r => r.provider_product_id);

      const syncExpansion = async (exp: CtExpansion) => {
        const done = deps.db.get<{ synced_at: string }>('SELECT synced_at FROM provider_group_sync WHERE provider = ? AND group_id = ?', [CARDTRADER_ID, String(exp.id)]);
        if (done && Date.now() - Date.parse(done.synced_at) < s.blueprintRefreshDays * 864e5) return;
        const bps = await call<CtBlueprint[]>(`/blueprints/export?expansion_id=${exp.id}`);
        const now = nowIso();
        deps.db.tx(() => {
          let n = 0;
          for (const b of Array.isArray(bps) ? bps : []) {
            if (b.game_id != null && b.game_id !== MTG_GAME_ID) continue;
            for (const cm of b.card_market_ids ?? []) {
              if (!Number.isInteger(cm)) continue;
              deps.db.run(`INSERT INTO provider_product_map (provider, product_external_id, provider_product_id, provider_group_id, updated_at)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET updated_at = excluded.updated_at, provider_group_id = excluded.provider_group_id`,
                [CARDTRADER_ID, cm, String(b.id), String(exp.id), now]);
              n++;
            }
          }
          deps.db.run(`INSERT INTO provider_group_sync (provider, group_id, synced_at, items) VALUES (?, ?, ?, ?)
            ON CONFLICT DO UPDATE SET synced_at = excluded.synced_at, items = excluded.items`, [CARDTRADER_ID, String(exp.id), now, n]);
        });
      };

      try {
        for (const t of targets) {
          const key = targetKey(t);
          let bps = blueprintsFor(t.externalId);
          if (!bps.length) {
            if (!t.setCode) { out.unsupported.push({ key, reason: 'Set-Code unbekannt (Scryfall-Zuordnung fehlt)' }); continue; }
            if (!expansions || Date.now() - expansions.at > 864e5) {
              const list = await call<CtExpansion[]>('/expansions');
              expansions = { at: Date.now(), byCode: new Map((Array.isArray(list) ? list : []).filter(e => e.game_id === MTG_GAME_ID).map(e => [String(e.code).toLowerCase(), e])) };
            }
            const exp = expansions.byCode.get(t.setCode.toLowerCase());
            if (!exp) { out.unsupported.push({ key, reason: `Edition ${t.setCode.toUpperCase()} bei CardTrader nicht gefunden` }); continue; }
            await syncExpansion(exp);
            bps = blueprintsFor(t.externalId);
            if (!bps.length) { out.unsupported.push({ key, reason: 'Kein CardTrader-Blueprint mit dieser Cardmarket-ID' }); continue; }
          }
          let answered = false;
          for (const bp of bps) {
            try {
              const res = await call<Record<string, CtProduct[]>>(`/marketplace/products?blueprint_id=${encodeURIComponent(bp)}&foil=${t.finish === 'foil'}`);
              const fetchedAt = nowIso();
              answered = true;
              for (const p of res?.[bp] ?? []) {
                const rec = mapCardTraderProduct(p, t, s.listingUrlTemplate, fetchedAt);
                if (rec.finish != null && rec.finish !== t.finish) continue; // andere Variante – gehört nicht zu diesem Ziel
                out.listings.push(rec);
              }
            } catch (e) {
              if (e instanceof StopRun) throw e;
              out.errors.push(`${t.name} (${key}): ${(e as Error).message}`);
            }
          }
          if (answered) out.covered.push(key);
        }
      } catch (e) {
        out.errors.push((e as Error).message);
      }
      return out;
    },
  };
}
