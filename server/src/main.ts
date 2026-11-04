import { APP_NAME, APP_VERSION, loadEnv, runtimeConfig } from './config.ts';
import { configureLog, logger } from './util/log.ts';
import { createApp } from './app.ts';

loadEnv();
const cfg = runtimeConfig();
configureLog({ file: cfg.logFile });
const log = logger('main');

const app = createApp();
app.server.on('error', (e: NodeJS.ErrnoException) => {
  log.error(e.code === 'EADDRINUSE' ? `Port ${cfg.port} ist belegt. Läuft der Server schon? Anderen Port per MTGDS_PORT in .env setzen.` : 'Serverfehler', e);
  process.exit(1);
});
app.server.listen(cfg.port, cfg.host, () => {
  log.info(`${APP_NAME} ${APP_VERSION} läuft: http://${cfg.host === '127.0.0.1' ? 'localhost' : cfg.host}:${cfg.port}`);
  log.info(`Datenbank: ${cfg.dbFile}`);
  if (app.scheduler) {
    app.scheduler.start();
    app.radar.start();
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info('Beende …');
    void app.close().then(() => process.exit(0));
  });
}
