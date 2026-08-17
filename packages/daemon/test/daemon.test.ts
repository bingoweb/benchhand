import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseEntityId, parseWorkspaceRecord } from '@udmcp/contracts';
import { createLocalRpcClient, RpcCallError } from '@udmcp/local-rpc';
import { OperationJournal } from '@udmcp/operations';
import { openSqliteDatabase } from '@udmcp/storage';

import { type DaemonHandle, DaemonStartError, startDaemon } from '../src/index.js';

function ipcPath(dir: string, name: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\udmcp-${name}-${process.pid}-${randomUUID()}`;
  }
  return join(dir, `${name}.sock`);
}

function testTempDir(prefix: string): string {
  const base = process.platform === 'win32' ? tmpdir() : '/tmp';
  return mkdtempSync(join(base, prefix));
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createGitRepository(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'UDMCP Test']);
  git(repo, ['config', 'user.email', 'udmcp-test@example.invalid']);
  writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  return repo;
}

function rawRpc(socketPath: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const request = http.request(
      {
        method: 'POST',
        path: '/rpc',
        socketPath,
        headers: {
          'content-type': 'application/json',
          'content-length': body.byteLength,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch (error) {
            reject(error);
          }
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

test('health is ready only after durable state is initialized', async () => {
  const dir = testTempDir('udmcp-daemon-health-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'health');

  try {
    const daemon = await startDaemon({ databasePath, socketPath });
    try {
      const client = createLocalRpcClient({ socketPath });
      const health = await client.call({
        requestId: 'req_health',
        method: 'system.health',
        params: {},
      });

      assert.deepEqual(health, {
        live: true,
        ready: true,
        state: 'healthy',
        instanceId: daemon.instanceId,
        rpcSchemaVersion: 1,
        storageIntegrity: 'ok',
      });
    } finally {
      await daemon.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports unsupported RPC schema versions with explicit negotiation details', async () => {
  const dir = testTempDir('udmcp-daemon-schema-version-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'schema-version');

  try {
    const daemon = await startDaemon({ databasePath, socketPath });
    try {
      const response = await rawRpc(socketPath, {
        schemaVersion: 2,
        requestId: 'req_schema_v2',
        method: 'system.health',
        params: {},
      });
      assert.deepEqual(response, {
        schemaVersion: 1,
        requestId: 'req_schema_v2',
        ok: false,
        error: {
          code: 'UNSUPPORTED_SCHEMA_VERSION',
          message: 'RPC schema version 2 is not supported',
          retryable: false,
          details: {
            requested: 2,
            supported: [1],
          },
        },
      });
    } finally {
      await daemon.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns structured errors for unknown methods and missing durable handles', async () => {
  const dir = testTempDir('udmcp-daemon-error-contract-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'error-contract');

  try {
    const daemon = await startDaemon({ databasePath, socketPath });
    try {
      const client = createLocalRpcClient({ socketPath });
      await assert.rejects(
        () =>
          client.call({
            requestId: 'req_unknown_method',
            method: 'fixture.unknown',
            params: {},
          }),
        (error: unknown) =>
          error instanceof RpcCallError &&
          error.code === 'METHOD_NOT_FOUND' &&
          error.retryable === false,
      );

      const operationId = parseEntityId('operation', 'op_missing_handle');
      await assert.rejects(
        () =>
          client.call({
            requestId: 'req_missing_operation',
            method: 'operation.get',
            params: { operationId },
          }),
        (error: unknown) =>
          error instanceof RpcCallError && error.code === 'NOT_FOUND' && error.retryable === false,
      );
    } finally {
      await daemon.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart returns CORE_UNAVAILABLE while down and preserves a durable operation handle', async () => {
  const dir = testTempDir('udmcp-daemon-restart-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'restart');
  const operationId = parseEntityId('operation', 'op_restart_handle');

  try {
    const seedDb = openSqliteDatabase(databasePath);
    try {
      const journal = new OperationJournal(seedDb);
      await journal.execute(
        {
          operationId,
          kind: 'fixture.restart',
          fingerprint: 'sha256:restart-v1',
        },
        () => ({ durable: true }),
      );
    } finally {
      seedDb.close();
    }

    const first = await startDaemon({ databasePath, socketPath });
    const client = createLocalRpcClient({ socketPath });
    const before = await client.call({
      requestId: 'req_before_restart',
      method: 'operation.get',
      params: { operationId },
    });
    assert.deepEqual(before, {
      operationId,
      kind: 'fixture.restart',
      fingerprint: 'sha256:restart-v1',
      state: 'committed',
      version: 2,
      result: { durable: true },
    });
    const firstInstanceId = first.instanceId;
    await first.close();

    await assert.rejects(
      () =>
        client.call({
          requestId: 'req_while_down',
          method: 'system.health',
          params: {},
        }),
      (error: unknown) => error instanceof RpcCallError && error.code === 'CORE_UNAVAILABLE',
    );

    const second = await startDaemon({ databasePath, socketPath });
    try {
      assert.notEqual(second.instanceId, firstInstanceId);
      const after = await client.call({
        requestId: 'req_after_restart',
        method: 'operation.get',
        params: { operationId },
      });
      assert.deepEqual(after, before);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace RPC reuses the same durable handle across daemon restart', async () => {
  const dir = testTempDir('udmcp-daemon-workspace-restart-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'workspace-restart');
  const project = join(dir, 'project');
  mkdirSync(project);
  let first: DaemonHandle | undefined;
  let second: DaemonHandle | undefined;

  try {
    first = await startDaemon({ databasePath, socketPath });
    const client = createLocalRpcClient({ socketPath });
    const opened = await client.call({
      requestId: 'req_workspace_open_first',
      method: 'workspace.open',
      params: { path: project },
    });
    const openedRecord = parseWorkspaceRecord(opened);
    const workspaceId = openedRecord.workspaceId;
    assert.equal(openedRecord.ownerInstance, first.instanceId);

    const before = await client.call({
      requestId: 'req_workspace_get_first',
      method: 'workspace.get',
      params: { workspaceId },
    });
    assert.deepEqual(parseWorkspaceRecord(before), openedRecord);
    await first.close();

    second = await startDaemon({ databasePath, socketPath });
    const reopened = await client.call({
      requestId: 'req_workspace_open_second',
      method: 'workspace.open',
      params: { path: project },
    });
    const reopenedRecord = parseWorkspaceRecord(reopened);
    assert.equal(reopenedRecord.workspaceId, workspaceId);
    assert.equal(reopenedRecord.ownerInstance, second.instanceId);
    assert.equal(reopenedRecord.metadataVersion, 2);

    rmSync(project, { recursive: true, force: true });
    const missing = await client.call({
      requestId: 'req_workspace_get_missing_path',
      method: 'workspace.get',
      params: { workspaceId },
    });
    const missingRecord = parseWorkspaceRecord(missing);
    assert.equal(missingRecord.workspaceId, workspaceId);
    assert.equal(missingRecord.status, 'missing');
  } finally {
    await second?.close();
    await first?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace RPC creates and reuses worktree mode across daemon restart', async () => {
  const dir = testTempDir('udmcp-daemon-worktree-restart-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'worktree-restart');
  const repo = createGitRepository(dir);
  let first: DaemonHandle | undefined;
  let second: DaemonHandle | undefined;

  try {
    first = await startDaemon({ databasePath, socketPath });
    const client = createLocalRpcClient({ socketPath });
    const firstRecord = parseWorkspaceRecord(
      await client.call({
        requestId: 'req_worktree_open_first',
        method: 'workspace.open',
        params: { path: repo, mode: 'worktree', baseRef: 'HEAD' },
      }),
    );
    assert.equal(firstRecord.mode, 'worktree');
    assert.equal(firstRecord.worktreePath, firstRecord.canonicalPath);
    assert.match(firstRecord.baseRef ?? '', /^[0-9a-f]{40,64}$/);
    assert.match(firstRecord.branch ?? '', /^udmcp\/[0-9a-f]{20}$/);
    await first.close();

    second = await startDaemon({ databasePath, socketPath });
    const secondRecord = parseWorkspaceRecord(
      await client.call({
        requestId: 'req_worktree_open_second',
        method: 'workspace.open',
        params: { path: repo, mode: 'worktree', baseRef: 'HEAD' },
      }),
    );
    assert.equal(secondRecord.workspaceId, firstRecord.workspaceId);
    assert.equal(secondRecord.canonicalPath, firstRecord.canonicalPath);
    assert.equal(secondRecord.ownerInstance, second.instanceId);
    assert.equal(secondRecord.metadataVersion, firstRecord.metadataVersion + 1);
  } finally {
    await second?.close();
    await first?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace RPC preserves structured path and missing-handle errors', async () => {
  const dir = testTempDir('udmcp-daemon-workspace-errors-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'workspace-errors');

  try {
    const daemon = await startDaemon({ databasePath, socketPath });
    try {
      const client = createLocalRpcClient({ socketPath });
      await assert.rejects(
        () =>
          client.call({
            requestId: 'req_workspace_missing_path',
            method: 'workspace.open',
            params: { path: join(dir, 'does-not-exist') },
          }),
        (error: unknown) =>
          error instanceof RpcCallError &&
          error.code === 'WORKSPACE_PATH_NOT_FOUND' &&
          error.retryable === false,
      );

      await assert.rejects(
        () =>
          client.call({
            requestId: 'req_workspace_missing_handle',
            method: 'workspace.get',
            params: { workspaceId: 'ws_missing' },
          }),
        (error: unknown) =>
          error instanceof RpcCallError && error.code === 'NOT_FOUND' && error.retryable === false,
      );
    } finally {
      await daemon.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('filesystem RPC reads lists and searches only through an available durable workspace', async () => {
  const dir = testTempDir('udmcp-daemon-filesystem-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'filesystem');
  const project = join(dir, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'b.ts'), 'beta needle\n');
  writeFileSync(join(project, 'src', 'a.ts'), 'alpha needle\nsecond\n');

  try {
    const daemon = await startDaemon({ databasePath, socketPath });
    try {
      const client = createLocalRpcClient({ socketPath });
      const workspace = parseWorkspaceRecord(
        await client.call({
          requestId: 'req_filesystem_workspace',
          method: 'workspace.open',
          params: { path: project },
        }),
      );

      const read = await client.call({
        requestId: 'req_file_read',
        method: 'file.read',
        params: {
          workspaceId: workspace.workspaceId,
          path: 'src/a.ts',
          offset: 0,
          maxBytes: 5,
        },
      });
      assert.deepEqual(read, {
        path: 'src/a.ts',
        classification: 'text',
        size: 20,
        offset: 0,
        bytesRead: 5,
        eof: false,
        truncated: true,
        content: 'alpha',
      });

      const list = await client.call({
        requestId: 'req_file_list',
        method: 'file.list',
        params: { workspaceId: workspace.workspaceId, path: 'src', limit: 10 },
      });
      assert.deepEqual(
        typeof list === 'object' &&
          list !== null &&
          'entries' in list &&
          Array.isArray(list.entries)
          ? list.entries.map((entry) =>
              typeof entry === 'object' && entry !== null && 'name' in entry ? entry.name : null,
            )
          : [],
        ['a.ts', 'b.ts'],
      );

      const search = await client.call({
        requestId: 'req_file_search',
        method: 'file.search',
        params: {
          workspaceId: workspace.workspaceId,
          path: '.',
          glob: 'src/**/*.ts',
          query: 'needle',
          maxResults: 10,
        },
      });
      assert.deepEqual(
        typeof search === 'object' &&
          search !== null &&
          'matches' in search &&
          Array.isArray(search.matches)
          ? search.matches.map((match) =>
              typeof match === 'object' && match !== null && 'path' in match ? match.path : null,
            )
          : [],
        ['src/a.ts', 'src/b.ts'],
      );

      await assert.rejects(
        () =>
          client.call({
            requestId: 'req_file_escape',
            method: 'file.read',
            params: { workspaceId: workspace.workspaceId, path: '../outside.txt' },
          }),
        (error: unknown) =>
          error instanceof RpcCallError && error.code === 'PATH_OUTSIDE_WORKSPACE',
      );
    } finally {
      await daemon.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovers a stale Unix socket left by a SIGKILLed daemon without losing durable state', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = testTempDir('udmcp-daemon-crash-restart-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'crash-restart');
  const fixture = fileURLToPath(new URL('./fixtures/daemon-worker.ts', import.meta.url));

  try {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      env: {
        ...process.env,
        UDMCP_TEST_DB: databasePath,
        UDMCP_TEST_SOCKET: socketPath,
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    await once(child, 'message');
    child.kill('SIGKILL');
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');

    const restarted = await startDaemon({ databasePath, socketPath });
    try {
      const client = createLocalRpcClient({ socketPath });
      const health = await client.call({
        requestId: 'req_after_crash_restart',
        method: 'system.health',
        params: {},
      });
      assert.equal(
        typeof health === 'object' && health !== null && 'ready' in health && health.ready,
        true,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never unlinks a non-socket file that occupies the configured Unix IPC path', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = testTempDir('udmcp-daemon-path-safety-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'protected-file');
  writeFileSync(socketPath, 'do-not-delete');

  try {
    await assert.rejects(
      () => startDaemon({ databasePath, socketPath }),
      (error: unknown) => error instanceof DaemonStartError && error.code === 'IPC_PATH_OCCUPIED',
    );
    assert.equal(existsSync(socketPath), true);
    assert.equal(readFileSync(socketPath, 'utf8'), 'do-not-delete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never steals an active Unix IPC endpoint from another daemon', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = testTempDir('udmcp-daemon-active-path-test-');
  const firstDatabasePath = join(dir, 'first.sqlite');
  const secondDatabasePath = join(dir, 'second.sqlite');
  const socketPath = ipcPath(dir, 'active');

  try {
    const first = await startDaemon({ databasePath: firstDatabasePath, socketPath });
    try {
      await assert.rejects(
        () => startDaemon({ databasePath: secondDatabasePath, socketPath }),
        (error: unknown) =>
          error instanceof DaemonStartError && error.code === 'IPC_ENDPOINT_IN_USE',
      );

      const client = createLocalRpcClient({ socketPath });
      const health = await client.call({
        requestId: 'req_active_owner',
        method: 'system.health',
        params: {},
      });
      assert.equal(
        typeof health === 'object' && health !== null && 'instanceId' in health
          ? health.instanceId
          : undefined,
        first.instanceId,
      );
    } finally {
      await first.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reclaims a genuinely stale Unix socket created by a crashed IPC owner', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = testTempDir('udmcp-daemon-stale-path-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = ipcPath(dir, 'stale');
  const fixture = fileURLToPath(new URL('./fixtures/stale-socket-worker.ts', import.meta.url));

  try {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      env: { ...process.env, UDMCP_TEST_SOCKET: socketPath },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    await once(child, 'message');
    assert.equal(existsSync(socketPath), true);
    child.kill('SIGKILL');
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    assert.equal(existsSync(socketPath), true);

    const daemon = await startDaemon({ databasePath, socketPath });
    try {
      const client = createLocalRpcClient({ socketPath });
      const health = await client.call({
        requestId: 'req_stale_reclaimed',
        method: 'system.health',
        params: {},
      });
      assert.equal(
        typeof health === 'object' && health !== null && 'ready' in health && health.ready,
        true,
      );
    } finally {
      await daemon.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects an overlong Unix socket path instead of allowing silent OS truncation', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = testTempDir('udmcp-daemon-long-path-test-');
  const databasePath = join(dir, 'state.sqlite');
  const socketPath = join(dir, `${'x'.repeat(160)}.sock`);
  let unexpectedDaemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

  try {
    try {
      unexpectedDaemon = await startDaemon({ databasePath, socketPath });
    } catch (error) {
      assert.equal(error instanceof DaemonStartError && error.code === 'IPC_PATH_TOO_LONG', true);
      return;
    }
    assert.fail('expected overlong Unix socket path to be rejected');
  } finally {
    await unexpectedDaemon?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
