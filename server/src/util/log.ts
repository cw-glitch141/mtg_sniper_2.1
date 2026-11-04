import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

let logFile: string | null = null;
let quiet = false;

export function configureLog(opts: { file?: string | null; quiet?: boolean }): void {
  if (opts.file !== undefined) {
    logFile = opts.file;
    if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  }
  if (opts.quiet !== undefined) quiet = opts.quiet;
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}` +
    (extra === undefined ? '' : ' ' + (extra instanceof Error ? (extra.stack ?? extra.message) : JSON.stringify(extra)));
  if (!quiet || level === 'error') {
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  }
  if (logFile) {
    try { appendFileSync(logFile, line + '\n'); } catch { /* Log-Datei nicht beschreibbar: Konsole reicht */ }
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string, x?: unknown) => { if (process.env.MTGDS_DEBUG) write('debug', scope, m, x); },
    info: (m: string, x?: unknown) => write('info', scope, m, x),
    warn: (m: string, x?: unknown) => write('warn', scope, m, x),
    error: (m: string, x?: unknown) => write('error', scope, m, x),
  };
}
