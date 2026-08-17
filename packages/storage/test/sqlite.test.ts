import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openSqliteDatabase } from '../src/index.js';

function withTempDatabase<T>(run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'udmcp-storage-test-'));
  try {
    return run(join(dir, 'state.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('opens every writable connection with the durable bootstrap policy', () => {
  withTempDatabase((path) => {
    const db = openSqliteDatabase(path, { busyTimeoutMs: 250 });
    try {
      assert.deepEqual(db.getSettings(), {
        journalMode: 'wal',
        synchronous: 2,
        foreignKeys: true,
        busyTimeoutMs: 250,
      });
      assert.equal(db.integrityCheck(), 'ok');
    } finally {
      db.close();
    }
  });
});

test('transaction commits atomically and rolls back thrown work', () => {
  withTempDatabase((path) => {
    const db = openSqliteDatabase(path);
    try {
      db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');

      db.transaction(() => {
        db.run('INSERT INTO items(value) VALUES (?)', ['committed']);
      });

      assert.throws(
        () =>
          db.transaction(() => {
            db.run('INSERT INTO items(value) VALUES (?)', ['rolled-back']);
            throw new Error('abort');
          }),
        /abort/,
      );

      assert.deepEqual(db.all('SELECT value FROM items ORDER BY id'), [{ value: 'committed' }]);
    } finally {
      db.close();
    }
  });
});

test('applies migrations exactly once and rejects checksum drift', () => {
  withTempDatabase((path) => {
    const db = openSqliteDatabase(path);
    try {
      const migration = {
        id: '0001-create-example',
        sql: 'CREATE TABLE example(id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
      };

      assert.deepEqual(db.applyMigrations([migration]), {
        applied: ['0001-create-example'],
        skipped: [],
      });
      assert.deepEqual(db.applyMigrations([migration]), {
        applied: [],
        skipped: ['0001-create-example'],
      });

      assert.throws(
        () =>
          db.applyMigrations([
            {
              id: migration.id,
              sql: `${migration.sql}\nCREATE INDEX example_value ON example(value);`,
            },
          ]),
        /migration checksum mismatch/i,
      );
    } finally {
      db.close();
    }
  });
});
