import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';

export type SqliteParameter = string | number | bigint | Buffer | null;
export type SqliteRow = Record<string, unknown>;

export interface SqliteSettings {
  journalMode: 'wal';
  synchronous: 2;
  foreignKeys: true;
  busyTimeoutMs: number;
}

export interface SqliteMigration {
  id: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface OpenSqliteDatabaseOptions {
  busyTimeoutMs?: number;
}

export class SqliteDatabase {
  readonly #database: Database.Database;
  readonly #busyTimeoutMs: number;

  constructor(path: string, options: OpenSqliteDatabaseOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new TypeError('busyTimeoutMs must be a non-negative integer');
    }

    this.#busyTimeoutMs = busyTimeoutMs;
    this.#database = new Database(path, { timeout: busyTimeoutMs });
    this.#bootstrapWritableConnection();
  }

  #bootstrapWritableConnection(): void {
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('synchronous = FULL');
    this.#database.pragma('foreign_keys = ON');
    this.#database.pragma(`busy_timeout = ${this.#busyTimeoutMs}`);

    const settings = this.getSettings();
    if (
      settings.journalMode !== 'wal' ||
      settings.synchronous !== 2 ||
      settings.foreignKeys !== true ||
      settings.busyTimeoutMs !== this.#busyTimeoutMs
    ) {
      this.#database.close();
      throw new Error(`SQLite durability bootstrap failed: ${JSON.stringify(settings)}`);
    }
  }

  getSettings(): SqliteSettings {
    const journalMode = this.#database.pragma('journal_mode', {
      simple: true,
    });
    const synchronous = this.#database.pragma('synchronous', {
      simple: true,
    });
    const foreignKeys = this.#database.pragma('foreign_keys', {
      simple: true,
    });
    const busyTimeoutMs = this.#database.pragma('busy_timeout', {
      simple: true,
    });

    if (
      journalMode !== 'wal' ||
      synchronous !== 2 ||
      foreignKeys !== 1 ||
      typeof busyTimeoutMs !== 'number'
    ) {
      throw new Error('SQLite connection is not using the required durability policy');
    }

    return {
      journalMode,
      synchronous,
      foreignKeys: true,
      busyTimeoutMs,
    };
  }

  integrityCheck(): string {
    const result = this.#database.pragma('integrity_check', { simple: true });
    if (typeof result !== 'string') {
      throw new Error('SQLite integrity_check returned an unexpected result');
    }
    return result;
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  run(sql: string, parameters: readonly SqliteParameter[] = []): Database.RunResult {
    return this.#database.prepare(sql).run(...parameters);
  }

  get<Row extends SqliteRow>(
    sql: string,
    parameters: readonly SqliteParameter[] = [],
  ): Row | undefined {
    return this.#database.prepare<SqliteParameter[], Row>(sql).get(...parameters);
  }

  all<Row extends SqliteRow>(sql: string, parameters: readonly SqliteParameter[] = []): Row[] {
    return this.#database.prepare<SqliteParameter[], Row>(sql).all(...parameters);
  }

  transaction<Result>(work: () => Result): Result {
    return this.#database.transaction(work).immediate();
  }

  applyMigrations(migrations: readonly SqliteMigration[]): MigrationResult {
    this.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `);

    const result: MigrationResult = { applied: [], skipped: [] };

    for (const migration of migrations) {
      if (migration.id.length === 0) {
        throw new TypeError('migration id must not be empty');
      }

      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const existing = this.get<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE id = ?',
        [migration.id],
      );

      if (existing !== undefined) {
        if (existing.checksum !== checksum) {
          throw new Error(`migration checksum mismatch for ${migration.id}`);
        }
        result.skipped.push(migration.id);
        continue;
      }

      this.transaction(() => {
        this.exec(migration.sql);
        this.run('INSERT INTO schema_migrations(id, checksum) VALUES (?, ?)', [
          migration.id,
          checksum,
        ]);
      });
      result.applied.push(migration.id);
    }

    return result;
  }

  close(): void {
    if (this.#database.open) {
      this.#database.close();
    }
  }
}

export function openSqliteDatabase(
  path: string,
  options: OpenSqliteDatabaseOptions = {},
): SqliteDatabase {
  return new SqliteDatabase(path, options);
}
