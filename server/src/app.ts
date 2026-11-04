import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { runtimeConfig, type RuntimeConfig } from './config.ts';
import { openDb, type Db } from './db/database.ts';
import { Router } from './api/http.ts';
import { registerRoutes } from './api/routes.ts';
import { registerBusinessRoutes } from './api/businessRoutes.ts';
import { createContext, type AppContext, type Providers } from './services/context.ts';
import { Scheduler } from './services/pipeline.ts';
import { LiveRadar } from './services/liveRadar.ts';
import { alertOperator } from './services/qualityReport.ts';

export function apiToken(db: Db): string {
  const row = db.get<{ value: string }>("SELECT value FROM app_meta WHERE key = 'api_token'");
  if (row) return row.value;
  const token = randomBytes(24).toString('hex');
  db.run("INSERT INTO app_meta (key, value) VALUES ('api_token', ?)", [token]);
  return token;
}

export interface App { ctx: AppContext; server: Server; scheduler: Scheduler | null; radar: LiveRadar; token: string; close(): Promise<void> }

export function createApp(opts: { cfg?: Partial<RuntimeConfig>; providers?: Partial<Providers>; scheduler?: boolean } = {}): App {
  const cfg = runtimeConfig(opts.cfg);
  const db = openDb(cfg.dbFile);
  const ctx = createContext(db, cfg, opts.providers);
  const token = apiToken(db);
  const scheduler = (opts.scheduler ?? cfg.schedulerEnabled) ? new Scheduler(ctx) : null;
  // Das Radar gibt es immer (für manuelle Abfragen); sein Zeitplan startet nur zusammen mit dem Scheduler.
  const radar = new LiveRadar(ctx, { onIngested: () => scheduler?.scheduleReanalysis(), afterPoll: () => alertOperator(ctx) });
  const router = new Router({ token, staticDir: cfg.webDist });
  registerRoutes(router, ctx, scheduler, token, radar);
  registerBusinessRoutes(router, ctx);
  const server = createServer((req, res) => void router.handle(req, res));
  return {
    ctx, server, scheduler, radar, token,
    close: () => new Promise<void>(resolve => {
      scheduler?.stop();
      radar.stop();
      server.close(() => { db.close(); resolve(); });
      server.closeAllConnections();
    }),
  };
}
