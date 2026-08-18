import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLocalRpcClient, RpcCallError } from '../src/index.js';

function unavailableSocketPath(): { dir: string; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'benchhand-rpc-client-test-'));
  return { dir, socketPath: testIpcPath(dir, 'missing') };
}

function testIpcPath(dir: string, name: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\benchhand-rpc-${name}-${process.pid}-${randomUUID()}`;
  }
  return join(dir, `${name}.sock`);
}

async function startDelayedRpcServer(socketPath: string, delayMs: number): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        requestId: string;
      };
      setTimeout(() => {
        if (response.destroyed) return;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            schemaVersion: 1,
            requestId: decoded.requestId,
            ok: true,
            result: { delayed: true },
          }),
        );
      }, delayMs);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server: http.Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test('maps an unavailable daemon endpoint to CORE_UNAVAILABLE', async () => {
  const { dir, socketPath } = unavailableSocketPath();
  try {
    const client = createLocalRpcClient({ socketPath });
    await assert.rejects(
      () =>
        client.call({
          requestId: 'req_unavailable',
          method: 'system.health',
          params: {},
        }),
      (error: unknown) =>
        error instanceof RpcCallError &&
        error.code === 'CORE_UNAVAILABLE' &&
        error.retryable === true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects an already-expired RPC deadline before transport', async () => {
  const { dir, socketPath } = unavailableSocketPath();
  try {
    const client = createLocalRpcClient({ socketPath });
    await assert.rejects(
      () =>
        client.call({
          requestId: 'req_timeout',
          method: 'system.health',
          params: {},
          deadlineUnixMs: Date.now() - 1,
        }),
      (error: unknown) => error instanceof RpcCallError && error.code === 'TIMEOUT',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maps a pre-aborted caller signal to CANCELLED', async () => {
  const { dir, socketPath } = unavailableSocketPath();
  try {
    const controller = new AbortController();
    controller.abort();
    const client = createLocalRpcClient({ socketPath });
    await assert.rejects(
      () =>
        client.call(
          {
            requestId: 'req_cancelled',
            method: 'system.health',
            params: {},
          },
          { signal: controller.signal },
        ),
      (error: unknown) => error instanceof RpcCallError && error.code === 'CANCELLED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aborts an in-flight RPC when its deadline expires', async () => {
  const { dir, socketPath } = unavailableSocketPath();
  const server = await startDelayedRpcServer(socketPath, 100);
  try {
    const client = createLocalRpcClient({ socketPath });
    await assert.rejects(
      () =>
        client.call({
          requestId: 'req_inflight_timeout',
          method: 'fixture.delay',
          params: {},
          deadlineUnixMs: Date.now() + 25,
        }),
      (error: unknown) => error instanceof RpcCallError && error.code === 'TIMEOUT',
    );
  } finally {
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aborts an in-flight RPC when the caller cancels it', async () => {
  const { dir, socketPath } = unavailableSocketPath();
  const server = await startDelayedRpcServer(socketPath, 100);
  try {
    const controller = new AbortController();
    const client = createLocalRpcClient({ socketPath });
    const call = client.call(
      {
        requestId: 'req_inflight_cancel',
        method: 'fixture.delay',
        params: {},
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 25);

    await assert.rejects(
      () => call,
      (error: unknown) => error instanceof RpcCallError && error.code === 'CANCELLED',
    );
  } finally {
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same client reconnects after the IPC server is replaced at the same endpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'benchhand-rpc-restart-test-'));
  const socketPath = testIpcPath(dir, 'restart');
  const client = createLocalRpcClient({ socketPath });
  let first: http.Server | undefined;
  let second: http.Server | undefined;

  try {
    first = await startDelayedRpcServer(socketPath, 0);
    assert.deepEqual(
      await client.call({
        requestId: 'req_before_server_restart',
        method: 'fixture.echo',
        params: {},
      }),
      { delayed: true },
    );
    await closeServer(first);
    first = undefined;

    second = await startDelayedRpcServer(socketPath, 0);
    assert.deepEqual(
      await client.call({
        requestId: 'req_after_server_restart',
        method: 'fixture.echo',
        params: {},
      }),
      { delayed: true },
    );
  } finally {
    await closeServer(second).catch(() => {});
    await closeServer(first).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
