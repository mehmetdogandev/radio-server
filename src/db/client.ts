import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { runBootstrapSql, runMigrationV2, runMigrationV3 } from './migrate.js';
import * as schema from './schema.js';

export function createDb(databasePath: string) {
  const dir = path.dirname(databasePath);
  fs.mkdirSync(dir, { recursive: true });
  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  runBootstrapSql(sqlite);
  runMigrationV2(sqlite);
  runMigrationV3(sqlite);
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
