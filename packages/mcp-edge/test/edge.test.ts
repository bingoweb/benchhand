import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseWorkspaceRecord } from '@udmcp/contracts';
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
      ['capabilities', 'health', 'system_info', 'workspace_get', 'workspace_open'],
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

test('workspace tools use the durable daemon registry and preserve the handle across daemon restart', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  const project = join(fixture.dir, 'project');
  const databasePath = join(fixture.dir, 'state.sqlite');
  mkdirSync(project);
  let restarted: DaemonHandle | undefined;

  try {
    const opened = await client.callTool({
      name: 'workspace_open',
      arguments: { path: project },
    });
    assert.equal(opened.isError, undefined);
    assert.equal(
      typeof opened.structuredContent === 'object' &&
        opened.structuredContent !== null &&
        'ok' in opened.structuredContent
        ? opened.structuredContent.ok
        : undefined,
      true,
    );
    const firstWorkspace = parseWorkspaceRecord(
      typeof opened.structuredContent === 'object' &&
        opened.structuredContent !== null &&
        'workspace' in opened.structuredContent
        ? opened.structuredContent.workspace
        : undefined,
    );

    const fetched = await client.callTool({
      name: 'workspace_get',
      arguments: { workspaceId: firstWorkspace.workspaceId },
    });
    assert.equal(fetched.isError, undefined);
    assert.deepEqual(
      parseWorkspaceRecord(
        typeof fetched.structuredContent === 'object' &&
          fetched.structuredContent !== null &&
          'workspace' in fetched.structuredContent
          ? fetched.structuredContent.workspace
          : undefined,
      ),
      firstWorkspace,
    );

    await fixture.daemon.close();
    restarted = await startDaemon({
      databasePath,
      socketPath: fixture.daemon.socketPath,
    });

    const reopened = await client.callTool({
      name: 'workspace_open',
      arguments: { path: project },
    });
    assert.equal(reopened.isError, undefined);
    const secondWorkspace = parseWorkspaceRecord(
      typeof reopened.structuredContent === 'object' &&
        reopened.structuredContent !== null &&
        'workspace' in reopened.structuredContent
        ? reopened.structuredContent.workspace
        : undefined,
    );
    assert.equal(secondWorkspace.workspaceId, firstWorkspace.workspaceId);
    assert.equal(secondWorkspace.ownerInstance, restarted.instanceId);
    assert.equal(secondWorkspace.metadataVersion, firstWorkspace.metadataVersion + 1);
  } finally {
    await restarted?.close();
    await client.close();
    await fixture.edge.close();
    await fixture.daemon.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('workspace_open exposes worktree mode and baseRef through the MCP edge', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  const repo = createGitRepository(fixture.dir);

  try {
    const listed = await client.listTools();
    const openTool = listed.tools.find((tool) => tool.name === 'workspace_open');
    assert.notEqual(openTool, undefined);
    const modeSchema =
      openTool?.inputSchema &&
      typeof openTool.inputSchema === 'object' &&
      'properties' in openTool.inputSchema &&
      typeof openTool.inputSchema.properties === 'object' &&
      openTool.inputSchema.properties !== null &&
      'mode' in openTool.inputSchema.properties
        ? openTool.inputSchema.properties.mode
        : undefined;
    assert.notEqual(modeSchema, undefined);
    assert.equal(JSON.stringify(modeSchema).includes('worktree'), true);

    const opened = await client.callTool({
      name: 'workspace_open',
      arguments: { path: repo, mode: 'worktree', baseRef: 'HEAD' },
    });
    assert.equal(opened.isError, undefined);
    const workspace = parseWorkspaceRecord(
      typeof opened.structuredContent === 'object' &&
        opened.structuredContent !== null &&
        'workspace' in opened.structuredContent
        ? opened.structuredContent.workspace
        : undefined,
    );
    assert.equal(workspace.mode, 'worktree');
    assert.equal(workspace.worktreePath, workspace.canonicalPath);
    assert.match(workspace.baseRef ?? '', /^[0-9a-f]{40,64}$/);
    assert.match(workspace.branch ?? '', /^udmcp\/[0-9a-f]{20}$/);
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
