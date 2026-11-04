import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS } from './migrations.ts';
import { logger } from '../util/log.ts';

const log = logger('db');

export type Row = Record<string, unknown>;
export type Params = Record<string, SQLInputValue> | SQLInputValue[];

/** Dünne Hülle um node:sqlite mit Hilfsfunktionen für Abfragen und Transaktionen. */
export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  private bind(params?: Params): SQLInputValue[] | [Record<string, SQLInputValue>] {
    if (params === undefined) return [];
    return Array.isArray(params) ? params : [params];
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    return this.raw.prepare(sql).all(...(this.bind(params) as SQLInputValue[])) as T[];
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    return this.raw.prepare(sql).get(...(this.bind(params) as SQLInputValue[])) as T | undefined;
  }

  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...(this.bind(params) as SQLInputValue[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Transaktion; verschachtelte Aufrufe laufen in der äußeren Transaktion mit. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function migrate(db: Db, backupDir?: string): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set(db.all<{ id: number }>('SELECT id FROM schema_migrations').map(r => r.id));
  const pending = MIGRATIONS.filter(m => !done.has(m.id));
  // Vor Migrationen einer bestehenden Datenbank eine vollständige Sicherung anlegen.
  if (backupDir && done.size > 0 && pending.length > 0) {
    mkdirSync(backupDir, { recursive: true });
    const target = join(backupDir, `mtgds-before-migration-${pending[0].id}-${Date.now()}.sqlite`);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    log.info(`Sicherung vor Migration angelegt: ${target}`);
  }
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.tx(() => {
      db.exec(m.sql);
      m.up?.(db);
      db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, new Date().toISOString()]);
    });
    log.info(`Migration ${m.id} (${m.name}) angewendet`);
    applied++;
  }
  return applied;
}

export function openDb(file: string): Db {
  const db = new Db(file);
  migrate(db, join(dirname(file), 'backups'));
  return db;
}

export const nowIso = (): string => new Date().toISOString();

/** JSON-Spalte sicher lesen. */
export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}
