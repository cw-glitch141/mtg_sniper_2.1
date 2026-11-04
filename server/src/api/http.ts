/**
 * Minimaler HTTP-Router ohne Abhängigkeiten.
 *
 * Sicherheit (lokaler Betrieb):
 *   - Server lauscht nur auf 127.0.0.1.
 *   - Host-Header muss localhost/127.0.0.1 sein (Schutz gegen DNS-Rebinding).
 *   - Schreibende Anfragen nur vom eigenen Dashboard (Sec-Fetch-Site: same-origin) oder mit
 *     X-MTGDS-Token (Browser-Erweiterung, CLI). Fremde Webseiten können so nichts verändern.
 *   - CORS nur für chrome-extension://-Ursprünge.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { logger } from '../util/log.ts';

const log = logger('http');

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  sameOrigin: boolean;
  tokenOk: boolean;
}

type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; open?: boolean }

export class Raw {
  readonly contentType: string;
  readonly body: string;
  readonly filename?: string;
  constructor(contentType: string, body: string, filename?: string) {
    this.contentType = contentType;
    this.body = body;
    this.filename = filename;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

export class Router {
  private routes: Route[] = [];
  private readonly token: string;
  private readonly staticDir: string | null;

  constructor(opts: { token: string; staticDir: string | null }) {
    this.token = opts.token;
    this.staticDir = opts.staticDir;
  }

  add(method: string, path: string, handler: Handler, opts: { open?: boolean } = {}): this {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/\./g, '\\.').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler, open: opts.open });
    return this;
  }
  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  put(p: string, h: Handler) { return this.add('PUT', p, h); }
  patch(p: string, h: Handler) { return this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { return this.add('DELETE', p, h); }

  private checkToken(v: string | string[] | undefined): boolean {
    if (typeof v !== 'string' || v.length !== this.token.length) return false;
    return timingSafeEqual(Buffer.from(v), Buffer.from(this.token));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const extOrigin = typeof origin === 'string' && origin.startsWith('chrome-extension://');
    if (extOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MTGDS-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const host = String(req.headers.host ?? '').toLowerCase();
      const hostname = host.replace(/:\d+$/, '');
      if (hostname !== '127.0.0.1' && hostname !== 'localhost') throw new ApiError(403, 'Unerlaubter Host-Header');
      if (req.method === 'OPTIONS') { res.writeHead(extOrigin ? 204 : 403).end(); return; }

      const url = new URL(req.url ?? '/', `http://${host}`);
      if (!url.pathname.startsWith('/api/')) { this.serveStatic(url.pathname, res); return; }

      const route = this.routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!route) throw new ApiError(404, `Unbekannter Endpunkt: ${req.method} ${url.pathname}`);
      const m = route.re.exec(url.pathname) as RegExpExecArray;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

      const sameOrigin = req.headers['sec-fetch-site'] === 'same-origin';
      const tokenOk = this.checkToken(req.headers['x-mtgds-token']);
      if (req.method !== 'GET' && !sameOrigin && !tokenOk) {
        throw new ApiError(401, 'Schreibzugriff nur vom Dashboard oder mit gültigem X-MTGDS-Token');
      }
      const body = req.method === 'GET' ? undefined : await readBody(req);
      const out = await route.handler({ req, res, params, query: url.searchParams, body, sameOrigin, tokenOk });
      if (res.headersSent) return;
      if (out instanceof Raw) {
        const h: Record<string, string> = { 'Content-Type': out.contentType };
        if (out.filename) h['Content-Disposition'] = `attachment; filename="${out.filename}"`;
        res.writeHead(200, h).end(out.body);
        return;
      }
      res.writeHead(out === undefined ? 204 : 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(out === undefined ? undefined : JSON.stringify(out));
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, 'Interner Fehler');
      if (!(e instanceof ApiError)) log.error(`${req.method} ${req.url}`, e);
      if (!res.headersSent) {
        res.writeHead(err.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message, details: err.details }));
      }
    }
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    if (!this.staticDir || !existsSync(join(this.staticDir, 'index.html'))) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Dashboard nicht gebaut</h1><p>Bitte zuerst <code>npm run build</code> ausführen. Die API läuft unter <a href="/api/status">/api/status</a>.</p>');
      return;
    }
    const root = resolve(this.staticDir);
    let file = resolve(normalize(join(root, decodeURIComponent(pathname))));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // SPA-Fallback
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': file.includes(`${join(root, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https://cards.scryfall.io data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    createReadStream(file).pipe(res);
  }
}

async function readBody(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, 'Anfrage zu groß');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const ct = String(req.headers['content-type'] ?? '');
  if (ct.includes('text/csv') || ct.includes('text/plain')) return { text };
  try { return JSON.parse(text); } catch { throw new ApiError(400, 'Ungültiges JSON'); }
}

// --- Eingabehilfen ---
export function obj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'JSON-Objekt erwartet');
  return body as Record<string, unknown>;
}
export function intParam(v: string | null | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ApiError(400, `${name} muss eine ganze Zahl sein`);
  return n;
}
export function optNum(q: URLSearchParams, k: string): number | undefined {
  const v = q.get(k);
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, `${k} muss eine Zahl sein`);
  return n;
}
