/**
 * Kommandozeile (ohne laufenden Server):
 *   node server/src/cli.ts import [--force] [--scryfall]   Katalog + Price Guide (+ Scryfall) importieren, analysieren, Alarme
 *   node server/src/cli.ts analyze                         nur Analyse + Alarme
 *   node server/src/cli.ts status                          Datenquellen-Status
 *   node server/src/cli.ts token                           API-Token für die Browser-Erweiterung anzeigen
 */
import { loadEnv, runtimeConfig } from './config.ts';
import { configureLog } from './util/log.ts';
import { createApp } from './app.ts';
import { analyzeAndAlert, runPipeline } from './services/pipeline.ts';
import { sourceStatus } from './services/importer.ts';

loadEnv();
const cfg = runtimeConfig();
configureLog({ file: cfg.logFile });
const [cmd, ...args] = process.argv.slice(2);
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
    default:
      console.log('Befehle: import [--force] [--scryfall] | analyze | status | token');
      process.exitCode = 2;
  }
} finally {
  app.ctx.db.close();
}
