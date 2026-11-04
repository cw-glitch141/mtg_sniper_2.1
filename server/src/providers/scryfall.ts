/**
 * Scryfall-Bulk-Daten ("Default Cards"): jede Karte in Englisch bzw. ihrer einzigen Drucksprache.
 * Enthält das Feld cardmarket_id (= Cardmarket idProduct) → Zuordnung von Set-Code, Collector Number,
 * Seltenheit, Finishes und Bild. Scryfall bittet, Bulk-Dateien statt Einzelabfragen zu nutzen und
 * Daten mindestens 24 h zu cachen; wir laden standardmäßig nur alle 7 Tage.
 * Format verifiziert am 04.11.2026: JSON Lines, gzip-komprimiert (jsonl_download_uri).
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { getJson } from './http.ts';

export interface ScryfallMapping {
  cardmarketId: number;
  scryfallId: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  rarity: string | null;
  finishes: string[];
  imageUrl: string | null;
  releasedAt: string | null;
  lang: string | null;
}

interface BulkInfo { jsonl_download_uri?: string; download_uri?: string; updated_at?: string }

export async function resolveBulkDownload(bulkUrl: string): Promise<{ url: string; updatedAt: string | null; gz: boolean }> {
  const r = await getJson<BulkInfo>(bulkUrl);
  if (r.notModified) throw new Error('Unerwartete 304-Antwort von Scryfall');
  const url = r.data.jsonl_download_uri ?? r.data.download_uri;
  if (!url) throw new Error('Scryfall-Bulk-Info enthält keine Download-URL');
  return { url, updatedAt: r.data.updated_at ?? null, gz: url.endsWith('.gz') };
}

export function mappingFromCard(c: Record<string, unknown>): ScryfallMapping | null {
  const cm = c.cardmarket_id;
  if (typeof cm !== 'number' || !Number.isInteger(cm)) return null;
  const faces = Array.isArray(c.card_faces) ? (c.card_faces as Record<string, unknown>[]) : [];
  const imgs = (c.image_uris ?? faces[0]?.image_uris) as Record<string, string> | undefined;
  return {
    cardmarketId: cm,
    scryfallId: String(c.id),
    setCode: String(c.set ?? '').toUpperCase(),
    setName: String(c.set_name ?? ''),
    collectorNumber: String(c.collector_number ?? ''),
    rarity: typeof c.rarity === 'string' ? c.rarity : null,
    finishes: Array.isArray(c.finishes) ? (c.finishes as string[]) : [],
    imageUrl: imgs?.small ?? imgs?.normal ?? null,
    releasedAt: typeof c.released_at === 'string' ? c.released_at : null,
    lang: typeof c.lang === 'string' ? c.lang : null,
  };
}

/** Liest eine (ggf. gzip-komprimierte) JSONL- oder zeilenweise JSON-Array-Datei und ruft onCard je Karte auf. */
export async function readBulkFile(file: string, gz: boolean, onCard: (m: ScryfallMapping) => void): Promise<{ lines: number; mapped: number; errors: number }> {
  const input = gz ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  const rl = createInterface({ input, crlfDelay: Infinity });
  let lines = 0, mapped = 0, errors = 0;
  for await (let line of rl) {
    line = line.trim();
    if (!line || line === '[' || line === ']') continue;
    if (line.endsWith(',')) line = line.slice(0, -1);
    lines++;
    try {
      const m = mappingFromCard(JSON.parse(line) as Record<string, unknown>);
      if (m) { onCard(m); mapped++; }
    } catch {
      errors++;
    }
  }
  return { lines, mapped, errors };
}
