import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type DaemonHandle, startDaemon } from '@udmcp/daemon';

import { type McpEdgeHandle, startMcpEdge } from '../src/index.js';

interface Fixture {
  dir: string;
  daemon: DaemonHandle;
  edge: McpEdgeHandle;
}

async function createFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'udmcp-mcp-edge-test-'));
  const daemon = await startDaemon({
    databasePath: join(dir, 'state.sqlite'),
    socketPath: join(dir, 'daemon.sock'),
  });
  const edge = await startMcpEdge({
    daemonSocketPath: daemon.socketPath,
    host: '127.0.0.1',
    port: 0,
  });
  return { dir, daemon, edge };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.edge.close();
  await fixture.daemon.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

async function connectClient(url: URL, mode: 'legacy' | 'auto' | 'modern'): Promise<Client> {
  const options =
    mode === 'modern'
      ? { versionNegotiation: { mode: { pin: '2026-07-28' as const } } }
      : mode === 'auto'
        ? { versionNegotiation: { mode: 'auto' as const } }
        : { versionNegotiation: { mode: 'legacy' as const } };

  const client = new Client({ name: `udmcp-test-${mode}`, version: '0.0.0' }, options);
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

test('pinned 2026 client discovers the modern era and calls the real daemon health tool', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  try {
    assert.equal(client.getProtocolEra(), 'modern');
    assert.deepEqual(client.getDiscoverResult()?.supportedVersions, ['2026-07-28']);
    assert.equal(client.getDiscoverResult()?.capabilities.tools?.listChanged, false);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['capabilities', 'health', 'system_info'],
    );

    const health = await client.callTool({ name: 'health', arguments: {} });
    assert.equal(health.isError, undefined);
    assert.deepEqual(health.structuredContent, {
      status: 'healthy',
      live: true,
      ready: true,
      rpcSchemaVersion: 1,
      storageIntegrity: 'ok',
    });
  } finally {
    await client.close();
    await closeFixture(fixture);
  }
});

test('legacy and auto clients negotiate their intended eras against the same endpoint', async () => {
  const fixture = await createFixture();
  const legacy = await connectClient(fixture.edge.url, 'legacy');
  const auto = await connectClient(fixture.edge.url, 'auto');
  try {
    assert.equal(legacy.getProtocolEra(), 'legacy');
    assert.equal(auto.getProtocolEra(), 'modern');

    for (const client of [legacy, auto]) {
      const listed = await client.listTools();
      assert.equal(
        listed.tools.some((tool) => tool.name === 'health'),
        true,
      );
      const health = await client.callTool({ name: 'health', arguments: {} });
      assert.equal(health.isError, undefined);
    }
  } finally {
    await legacy.close();
    await auto.close();
    await closeFixture(fixture);
  }
});

test('tools/list cannot mask a dead daemon when the listed health tool is actually invoked', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  try {
    const listed = await client.listTools();
    assert.equal(
      listed.tools.some((tool) => tool.name === 'health'),
      true,
    );

    await fixture.daemon.close();
    const health = await client.callTool({ name: 'health', arguments: {} });
    assert.equal(health.isError, true);
    assert.deepEqual(health.structuredContent, {
      status: 'unavailable',
      errorCode: 'CORE_UNAVAILABLE',
      retryable: true,
    });
  } finally {
    await client.close();
    await fixture.edge.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
