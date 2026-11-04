/**
 * Kommandozeile (ohne laufenden Server):
 *   node server/src/cli.ts import [--force] [--scryfall]   Katalog + Price Guide (+ Scryfall) importieren, analysieren, Alarme
 *   node server/src/cli.ts analyze                         nur Analyse + Alarme
 *   node server/src/cli.ts status                          Datenquellen-Status
 *   node server/src/cli.ts token                           API-Token für die Browser-Erweiterung anzeigen
 *   node server/src/cli.ts live-status                     Status der Listing-Feeds (ehrlich: verbunden oder nicht)
 *   node server/src/cli.ts live-poll                       alle bereiten Feeds einmal abfragen
 *   node server/src/cli.ts report [--tests <json>] [--out <ordner>]
 *                                                          Qualitätsbericht erzeugen, speichern und als Markdown ablegen
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv, runtimeConfig } from './config.ts';
import { configureLog } from './util/log.ts';
import { createApp } from './app.ts';
import { analyzeAndAlert, runPipeline } from './services/pipeline.ts';
import { sourceStatus } from './services/importer.ts';
import { liveStatus, pollProvider } from './services/liveRadar.ts';
import { alertOperator, buildQualityReport, renderQualityMarkdown, saveQualityReport, type TestSummary } from './services/qualityReport.ts';

loadEnv();
const cfg = runtimeConfig();
configureLog({ file: cfg.logFile });
const [cmd, ...args] = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };
const app = createApp({ scheduler: false });

try {
  switch (cmd) {
    case 'import': {
      const r = await runPipeline(app.ctx, { force: args.includes('--force'), scryfall: args.includes('--scryfall') ? true : undefined });
      console.log(JSON.stringify(r, null, 2));
      if (r.imports.some(i => i.status === 'failed')) process.exitCode = 1;
      break;
    }
    case 'analyze':
      console.log(JSON.stringify(await analyzeAndAlert(app.ctx), null, 2));
      break;
    case 'status':
      console.log(JSON.stringify(sourceStatus(app.ctx), null, 2));
      break;
    case 'token':
      console.log(app.token);
      break;
    case 'live-status':
      console.log(JSON.stringify(liveStatus(app.ctx), null, 2));
      break;
    case 'live-poll': {
      for (const p of app.ctx.providers.listings) console.log(JSON.stringify(await pollProvider(app.ctx, p), null, 2));
      break;
    }
    case 'report': {
      const testsFile = opt('--tests');
      const tests = testsFile ? JSON.parse(readFileSync(testsFile, 'utf8').replace(/^﻿/, '')) as TestSummary : null;
      const rep = saveQualityReport(app.ctx.db, buildQualityReport(app.ctx, { tests }));
      await alertOperator(app.ctx);
      const dir = resolve(opt('--out') ?? join(cfg.dataDir, 'reports'));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `quality-${rep.createdAt.slice(0, 10)}.md`);
      writeFileSync(file, renderQualityMarkdown(rep), 'utf8');
      console.log(`Qualitätsbericht #${rep.id}: ${rep.status} (${rep.findings.length} Befunde) → ${file}`);
      if (rep.status === 'critical') process.exitCode = 1;
      break;
    }
    default:
      console.log('Befehle: import [--force] [--scryfall] | analyze | status | token | live-status | live-poll | report [--tests <json>] [--out <ordner>]');
      process.exitCode = 2;
  }
} finally {
  app.ctx.db.close();
}
