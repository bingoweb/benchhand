import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseEntityId } from '@udmcp/contracts';
import { openSqliteDatabase, type SqliteDatabase } from '@udmcp/storage';

import { OperationConflictError, OperationJournal } from '../src/index.js';

async function withJournal<T>(
  run: (journal: OperationJournal, path: string, db: SqliteDatabase) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'udmcp-operation-test-'));
  const path = join(dir, 'state.sqlite');
  const db = openSqliteDatabase(path);
  const journal = new OperationJournal(db);
  try {
    return await run(journal, path, db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('replays a committed operation without running the effect twice', async () => {
  await withJournal(async (journal) => {
    const operationId = parseEntityId('operation', 'op_duplicate');
    let effects = 0;
    const request = {
      operationId,
      kind: 'fixture.increment',
      fingerprint: 'sha256:fixture-v1',
    };

    const first = await journal.execute(request, () => {
      effects += 1;
      return { effects };
    });
    const second = await journal.execute(request, () => {
      effects += 1;
      return { effects };
    });

    assert.equal(effects, 1);
    assert.deepEqual(first, {
      disposition: 'executed',
      state: 'committed',
      result: { effects: 1 },
    });
    assert.deepEqual(second, {
      disposition: 'replayed',
      state: 'committed',
      result: { effects: 1 },
    });
  });
});

test('reads a durable operation record by its stable handle', async () => {
  await withJournal(async (journal) => {
    const operationId = parseEntityId('operation', 'op_read_handle');
    await journal.execute(
      {
        operationId,
        kind: 'fixture.readable',
        fingerprint: 'sha256:readable-v1',
      },
      () => ({ value: 42 }),
    );

    assert.deepEqual(journal.get(operationId), {
      operationId,
      kind: 'fixture.readable',
      fingerprint: 'sha256:readable-v1',
      state: 'committed',
      version: 2,
      result: { value: 42 },
    });
  });
});

test('rejects reusing an operation id for a different fingerprint', async () => {
  await withJournal(async (journal) => {
    const operationId = parseEntityId('operation', 'op_conflict');
    await journal.execute(
      {
        operationId,
        kind: 'fixture.write',
        fingerprint: 'sha256:first',
      },
      () => ({ ok: true }),
    );

    await assert.rejects(
      () =>
        journal.execute(
          {
            operationId,
            kind: 'fixture.write',
            fingerprint: 'sha256:second',
          },
          () => ({ ok: false }),
        ),
      (error: unknown) => error instanceof OperationConflictError,
    );
  });
});

test('persists a failed effect and never runs it again on duplicate replay', async () => {
  await withJournal(async (journal) => {
    const operationId = parseEntityId('operation', 'op_failed');
    const request = {
      operationId,
      kind: 'fixture.failure',
      fingerprint: 'sha256:failure-v1',
    };
    let effects = 0;

    await assert.rejects(
      () =>
        journal.execute(request, () => {
          effects += 1;
          throw new Error('fixture exploded');
        }),
      /fixture exploded/,
    );

    const replay = await journal.execute(request, () => {
      effects += 1;
      return { impossible: true };
    });

    assert.equal(effects, 1);
    assert.deepEqual(replay, {
      disposition: 'replayed',
      state: 'failed',
      error: {
        name: 'Error',
        message: 'fixture exploded',
      },
    });
  });
});

test('startup reconciliation turns interrupted work into reconcile-required', async () => {
  await withJournal(async (journal, path, db) => {
    const operationId = parseEntityId('operation', 'op_interrupted');
    const request = {
      operationId,
      kind: 'fixture.external-effect',
      fingerprint: 'sha256:external-v1',
    };

    const claim = journal.prepare(request);
    assert.equal(claim.disposition, 'execute');
    journal.markRunning(operationId);

    db.close();
    const reopenedDb = openSqliteDatabase(path);
    const reopened = new OperationJournal(reopenedDb);
    try {
      assert.equal(reopened.reconcileInterrupted(), 1);
      let effects = 0;
      const outcome = await reopened.execute(request, () => {
        effects += 1;
        return { effects };
      });

      assert.equal(effects, 0);
      assert.deepEqual(outcome, {
        disposition: 'reconcile-required',
        state: 'unknown-needs-reconcile',
      });
    } finally {
      reopenedDb.close();
    }
  });
});

test('real SIGKILL leaves durable running state for startup reconciliation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'udmcp-operation-crash-test-'));
  const path = join(dir, 'state.sqlite');
  const fixture = fileURLToPath(new URL('./fixtures/interrupted-worker.ts', import.meta.url));

  try {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      env: { ...process.env, UDMCP_TEST_DB: path },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    await once(child, 'message');
    child.kill('SIGKILL');
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');

    const db = openSqliteDatabase(path);
    const journal = new OperationJournal(db);
    try {
      assert.equal(journal.reconcileInterrupted(), 1);
      const operationId = parseEntityId('operation', 'op_sigkill');
      let effects = 0;
      const outcome = await journal.execute(
        {
          operationId,
          kind: 'fixture.sigkill',
          fingerprint: 'sha256:sigkill-v1',
        },
        () => {
          effects += 1;
          return { effects };
        },
      );

      assert.equal(effects, 0);
      assert.deepEqual(outcome, {
        disposition: 'reconcile-required',
        state: 'unknown-needs-reconcile',
      });
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
