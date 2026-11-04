import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { USER_AGENT } from '../config.ts';

export interface Conditional { etag?: string | null; lastModified?: string | null }
export interface HttpMeta { etag: string | null; lastModified: string | null; status: number }

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function headers(cond?: Conditional, accept = 'application/json'): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: accept };
  if (cond?.etag) h['If-None-Match'] = cond.etag;
  if (cond?.lastModified) h['If-Modified-Since'] = cond.lastModified;
  return h;
}

async function doFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 && attempt === 0) { lastErr = new HttpError(res.status, `HTTP ${res.status}`); await new Promise(r => setTimeout(r, 3000)); continue; }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const meta = (res: Response): HttpMeta => ({ etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), status: res.status });

/** Leichte Prüfung, ob sich eine Datei geändert hat (HEAD-Request). */
export async function head(url: string, timeoutMs = 30_000): Promise<HttpMeta> {
  const res = await doFetch(url, { method: 'HEAD', headers: headers() }, timeoutMs);
  if (!res.ok) throw new HttpError(res.status, `HEAD ${url} → HTTP ${res.status}`);
  return meta(res);
}

/** JSON laden; bei 304 (unverändert) wird `notModified` gemeldet. */
export async function getJson<T>(url: string, cond?: Conditional, timeoutMs = 180_000):
  Promise<{ notModified: true; meta: HttpMeta } | { notModified: false; meta: HttpMeta; data: T; bytes: number; text: string }> {
  const res = await doFetch(url, { headers: headers(cond) }, timeoutMs);
  if (res.status === 304) return { notModified: true, meta: meta(res) };
  if (!res.ok) throw new HttpError(res.status, `GET ${url} → HTTP ${res.status}`);
  const text = await res.text();
  let data: T;
  try { data = JSON.parse(text) as T; } catch (e) { throw new Error(`Ungültiges JSON von ${url}: ${(e as Error).message}`); }
  return { notModified: false, meta: meta(res), data, bytes: Buffer.byteLength(text), text };
}

/** Große Datei streamend auf die Platte laden (atomar über .part-Datei). */
export async function downloadToFile(url: string, file: string, timeoutMs = 900_000): Promise<HttpMeta> {
  const res = await doFetch(url, { headers: headers(undefined, '*/*') }, timeoutMs);
  if (!res.ok || !res.body) throw new HttpError(res.status, `GET ${url} → HTTP ${res.status}`);
  const part = file + '.part';
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(part));
    await rename(part, file);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
  return meta(res);
}
