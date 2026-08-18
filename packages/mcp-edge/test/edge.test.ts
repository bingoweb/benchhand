import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseWorkspaceRecord } from '@benchhand/contracts';
import { type DaemonHandle, startDaemon } from '@benchhand/daemon';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { type McpEdgeHandle, startMcpEdge } from '../src/index.js';

interface Fixture {
  dir: string;
  daemon: DaemonHandle;
  edge: McpEdgeHandle;
}

async function createFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'benchhand-mcp-edge-test-'));
  const daemon = await startDaemon({
    databasePath: join(dir, 'state.sqlite'),
    socketPath: testIpcPath(dir, 'daemon'),
  });
  const edge = await startMcpEdge({
    daemonSocketPath: daemon.socketPath,
    host: '127.0.0.1',
    port: 0,
  });
  return { dir, daemon, edge };
}

function testIpcPath(dir: string, name: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\benchhand-edge-${name}-${process.pid}-${randomUUID()}`;
  }
  return join(dir, `${name}.sock`);
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

  const client = new Client({ name: `benchhand-test-${mode}`, version: '0.0.0' }, options);
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
  git(repo, ['config', 'user.name', 'Benchhand Test']);
  git(repo, ['config', 'user.email', 'benchhand-test@example.invalid']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  return repo;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function nativeFileDurability(): 'file-and-directory' | 'file-only' {
  return process.platform === 'win32' ? 'file-only' : 'file-and-directory';
}

test('pinned 2026 client discovers the modern era and calls the real daemon health tool', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  try {
    assert.equal(client.getProtocolEra(), 'modern');
    assert.deepEqual(client.getDiscoverResult()?.supportedVersions, ['2026-07-28']);
    assert.equal(client.getDiscoverResult()?.capabilities.tools?.listChanged, false);
    const discovery = JSON.stringify(client.getDiscoverResult());
    assert.equal(discovery.includes('"name":"benchhand"'), true);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [
        'capabilities',
        'health',
        'system_info',
        'file_read',
        'file_list',
        'file_search',
        'file_write',
        'file_patch',
        'instructions_resolve',
        'skills_list',
        'skill_read',
        'workspace_get',
        'workspace_open',
      ],
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
    assert.match(workspace.branch ?? '', /^benchhand\/[0-9a-f]{20}$/);
  } finally {
    await client.close();
    await closeFixture(fixture);
  }
});

test('file tools expose bounded read list and search through a durable workspace handle', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  const project = join(fixture.dir, 'file-project');
  mkdirSync(join(project, 'notes'), { recursive: true });
  writeFileSync(join(project, 'notes', 'b.txt'), 'beta needle\n');
  writeFileSync(join(project, 'notes', 'a.txt'), 'alpha needle\nsecond\n');

  try {
    const listed = await client.listTools();
    for (const name of ['file_read', 'file_list', 'file_search']) {
      assert.equal(
        listed.tools.some((tool) => tool.name === name),
        true,
        `missing ${name}`,
      );
    }

    const opened = await client.callTool({
      name: 'workspace_open',
      arguments: { path: project },
    });
    const workspace = parseWorkspaceRecord(
      typeof opened.structuredContent === 'object' &&
        opened.structuredContent !== null &&
        'workspace' in opened.structuredContent
        ? opened.structuredContent.workspace
        : undefined,
    );

    const read = await client.callTool({
      name: 'file_read',
      arguments: {
        workspaceId: workspace.workspaceId,
        path: 'notes/a.txt',
        offset: 0,
        maxBytes: 5,
      },
    });
    assert.equal(read.isError, undefined);
    assert.equal(
      typeof read.structuredContent === 'object' &&
        read.structuredContent !== null &&
        'file' in read.structuredContent &&
        typeof read.structuredContent.file === 'object' &&
        read.structuredContent.file !== null &&
        'content' in read.structuredContent.file
        ? read.structuredContent.file.content
        : undefined,
      'alpha',
    );

    const list = await client.callTool({
      name: 'file_list',
      arguments: { workspaceId: workspace.workspaceId, path: 'notes', limit: 10 },
    });
    assert.equal(list.isError, undefined);
    assert.deepEqual(
      typeof list.structuredContent === 'object' &&
        list.structuredContent !== null &&
        'listing' in list.structuredContent &&
        typeof list.structuredContent.listing === 'object' &&
        list.structuredContent.listing !== null &&
        'entries' in list.structuredContent.listing &&
        Array.isArray(list.structuredContent.listing.entries)
        ? list.structuredContent.listing.entries.map((entry) =>
            typeof entry === 'object' && entry !== null && 'name' in entry ? entry.name : null,
          )
        : [],
      ['a.txt', 'b.txt'],
    );

    const search = await client.callTool({
      name: 'file_search',
      arguments: {
        workspaceId: workspace.workspaceId,
        path: '.',
        glob: 'notes/**/*.txt',
        query: 'needle',
        maxResults: 10,
      },
    });
    assert.equal(search.isError, undefined);
    assert.deepEqual(
      typeof search.structuredContent === 'object' &&
        search.structuredContent !== null &&
        'search' in search.structuredContent &&
        typeof search.structuredContent.search === 'object' &&
        search.structuredContent.search !== null &&
        'matches' in search.structuredContent.search &&
        Array.isArray(search.structuredContent.search.matches)
        ? search.structuredContent.search.matches.map((match) =>
            typeof match === 'object' && match !== null && 'path' in match ? match.path : null,
          )
        : [],
      ['notes/a.txt', 'notes/b.txt'],
    );
  } finally {
    await client.close();
    await closeFixture(fixture);
  }
});

test('file_write exposes atomic hash-precondition semantics and non-idempotent mutation annotations', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  const project = join(fixture.dir, 'write-project');
  mkdirSync(project);
  writeFileSync(join(project, 'config.txt'), 'before\n');

  try {
    const listed = await client.listTools();
    const writeTool = listed.tools.find((tool) => tool.name === 'file_write');
    assert.notEqual(writeTool, undefined);
    assert.deepEqual(writeTool?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });

    const opened = await client.callTool({ name: 'workspace_open', arguments: { path: project } });
    const workspace = parseWorkspaceRecord(
      typeof opened.structuredContent === 'object' &&
        opened.structuredContent !== null &&
        'workspace' in opened.structuredContent
        ? opened.structuredContent.workspace
        : undefined,
    );

    const written = await client.callTool({
      name: 'file_write',
      arguments: {
        workspaceId: workspace.workspaceId,
        path: 'config.txt',
        content: 'after\n',
        expectedSha256: sha256('before\n'),
      },
    });
    assert.equal(written.isError, undefined);
    assert.equal(
      typeof written.structuredContent === 'object' &&
        written.structuredContent !== null &&
        'write' in written.structuredContent &&
        typeof written.structuredContent.write === 'object' &&
        written.structuredContent.write !== null &&
        'sha256' in written.structuredContent.write
        ? written.structuredContent.write.sha256
        : undefined,
      sha256('after\n'),
    );

    const stale = await client.callTool({
      name: 'file_write',
      arguments: {
        workspaceId: workspace.workspaceId,
        path: 'config.txt',
        content: 'stale\n',
        expectedSha256: sha256('before\n'),
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(
      typeof stale.structuredContent === 'object' &&
        stale.structuredContent !== null &&
        'errorCode' in stale.structuredContent
        ? stale.structuredContent.errorCode
        : undefined,
      'WRITE_CONFLICT',
    );
  } finally {
    await client.close();
    await closeFixture(fixture);
  }
});

test('file_patch exposes deterministic exact edits and structured conflict evidence', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  const project = join(fixture.dir, 'patch-project');
  mkdirSync(project);
  const ambiguousBefore = 'same\nmiddle\nsame\n';
  writeFileSync(join(project, 'config.txt'), ambiguousBefore);

  try {
    const listed = await client.listTools();
    const patchTool = listed.tools.find((tool) => tool.name === 'file_patch');
    assert.notEqual(patchTool, undefined);
    assert.deepEqual(patchTool?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });

    const opened = await client.callTool({ name: 'workspace_open', arguments: { path: project } });
    const workspace = parseWorkspaceRecord(
      typeof opened.structuredContent === 'object' &&
        opened.structuredContent !== null &&
        'workspace' in opened.structuredContent
        ? opened.structuredContent.workspace
        : undefined,
    );

    const ambiguous = await client.callTool({
      name: 'file_patch',
      arguments: {
        workspaceId: workspace.workspaceId,
        path: 'config.txt',
        expectedSha256: sha256(ambiguousBefore),
        edits: [{ oldText: 'same', newText: 'changed' }],
      },
    });
    assert.equal(ambiguous.isError, true);
    assert.deepEqual(ambiguous.structuredContent, {
      ok: false,
      errorCode: 'PATCH_CONFLICT',
      message: 'patch edit 0 is ambiguous in config.txt',
      retryable: false,
      details: {
        path: 'config.txt',
        reason: 'ambiguous_match',
        editIndex: 0,
        matchCount: 2,
      },
    });
    assert.equal(readFileSync(join(project, 'config.txt'), 'utf8'), ambiguousBefore);

    const before = 'alpha = 1\nbeta = 2\ngamma = 3\n';
    const after = 'alpha = 10\nbeta = 2\ngamma = 30\n';
    writeFileSync(join(project, 'config.txt'), before);
    const patched = await client.callTool({
      name: 'file_patch',
      arguments: {
        workspaceId: workspace.workspaceId,
        path: 'config.txt',
        expectedSha256: sha256(before),
        edits: [
          { oldText: 'alpha = 1', newText: 'alpha = 10' },
          { oldText: 'gamma = 3', newText: 'gamma = 30' },
        ],
      },
    });
    assert.equal(patched.isError, undefined);
    assert.deepEqual(patched.structuredContent, {
      ok: true,
      patch: {
        path: 'config.txt',
        previousSha256: sha256(before),
        sha256: sha256(after),
        editsApplied: 2,
        bytesWritten: Buffer.byteLength(after),
        durability: nativeFileDurability(),
      },
    });
    assert.equal(readFileSync(join(project, 'config.txt'), 'utf8'), after);
  } finally {
    await client.close();
    await closeFixture(fixture);
  }
});

test('instructions_resolve exposes hierarchical agent instructions as a read-only MCP tool', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  const project = join(fixture.dir, 'instructions-project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'AGENTS.md'), 'root agents\n');
  writeFileSync(join(project, 'src', 'CLAUDE.md'), 'src claude\n');

  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'instructions_resolve');
    assert.notEqual(tool, undefined);
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const opened = await client.callTool({
      name: 'workspace_open',
      arguments: { path: project },
    });
    const workspace = parseWorkspaceRecord(
      typeof opened.structuredContent === 'object' &&
        opened.structuredContent !== null &&
        'workspace' in opened.structuredContent
        ? opened.structuredContent.workspace
        : undefined,
    );

    const resolved = await client.callTool({
      name: 'instructions_resolve',
      arguments: { workspaceId: workspace.workspaceId, scopePath: 'src' },
    });
    assert.equal(resolved.isError, undefined);
    assert.deepEqual(resolved.structuredContent, {
      ok: true,
      resolution: {
        workspaceId: workspace.workspaceId,
        scopePath: 'src',
        scopes: ['.', 'src'],
        documents: [
          {
            providerId: 'builtin.agents',
            scopePath: '.',
            sourceId: 'AGENTS.md',
            path: 'AGENTS.md',
            content: 'root agents\n',
            sha256: sha256('root agents\n'),
          },
          {
            providerId: 'builtin.claude',
            scopePath: 'src',
            sourceId: 'CLAUDE.md',
            path: 'src/CLAUDE.md',
            content: 'src claude\n',
            sha256: sha256('src claude\n'),
          },
        ],
      },
    });

    const escaped = await client.callTool({
      name: 'instructions_resolve',
      arguments: { workspaceId: workspace.workspaceId, scopePath: '../outside' },
    });
    assert.equal(escaped.isError, true);
    assert.deepEqual(escaped.structuredContent, {
      ok: false,
      errorCode: 'PATH_OUTSIDE_WORKSPACE',
      message: 'scope path traversal is not allowed',
      retryable: false,
      details: { path: '../outside' },
    });
  } finally {
    await client.close();
    await closeFixture(fixture);
  }
});

test('skills_list exposes metadata-only Agent Skills discovery as a read-only MCP tool', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  const project = join(fixture.dir, 'skills-list-project');
  const skillDirectory = join(project, '.agents', 'skills', 'review-change');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    '---\nname: review-change\ndescription: Review a change before merging.\n---\n\n# Hidden skill body\n',
  );

  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'skills_list');
    assert.notEqual(tool, undefined);
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const opened = await client.callTool({
      name: 'workspace_open',
      arguments: { path: project },
    });
    const workspace = parseWorkspaceRecord(
      typeof opened.structuredContent === 'object' &&
        opened.structuredContent !== null &&
        'workspace' in opened.structuredContent
        ? opened.structuredContent.workspace
        : undefined,
    );
    const result = await client.callTool({
      name: 'skills_list',
      arguments: { workspaceId: workspace.workspaceId },
    });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.stringify(result.structuredContent).includes('Hidden skill body'), false);
    assert.deepEqual(
      typeof result.structuredContent === 'object' &&
        result.structuredContent !== null &&
        'catalog' in result.structuredContent &&
        typeof result.structuredContent.catalog === 'object' &&
        result.structuredContent.catalog !== null &&
        'skills' in result.structuredContent.catalog &&
        Array.isArray(result.structuredContent.catalog.skills)
        ? result.structuredContent.catalog.skills.map((skill) =>
            typeof skill === 'object' &&
            skill !== null &&
            'skillId' in skill &&
            'description' in skill
              ? { skillId: skill.skillId, description: skill.description }
              : null,
          )
        : [],
      [{ skillId: 'project:review-change', description: 'Review a change before merging.' }],
    );
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

test('skill_read loads the selected SKILL.md body only after explicit activation', async () => {
  const fixture = await createFixture();
  const client = await connectClient(fixture.edge.url, 'modern');
  const project = join(fixture.dir, 'skill-read-project');
  const skillDirectory = join(project, '.agents', 'skills', 'release-check');
  mkdirSync(skillDirectory, { recursive: true });
  const source =
    '---\nname: release-check\ndescription: Validate a release before publishing.\n---\n\n# Release Check\n\nFull skill body.\n';
  writeFileSync(join(skillDirectory, 'SKILL.md'), source);

  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'skill_read');
    assert.notEqual(tool, undefined);
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const opened = await client.callTool({
      name: 'workspace_open',
      arguments: { path: project },
    });
    const workspace = parseWorkspaceRecord(
      typeof opened.structuredContent === 'object' &&
        opened.structuredContent !== null &&
        'workspace' in opened.structuredContent
        ? opened.structuredContent.workspace
        : undefined,
    );
    const result = await client.callTool({
      name: 'skill_read',
      arguments: { workspaceId: workspace.workspaceId, skillId: 'project:release-check' },
    });
    assert.equal(result.isError, undefined);
    const skill =
      typeof result.structuredContent === 'object' &&
      result.structuredContent !== null &&
      'skill' in result.structuredContent &&
      typeof result.structuredContent.skill === 'object' &&
      result.structuredContent.skill !== null
        ? result.structuredContent.skill
        : undefined;
    assert.equal(skill && 'content' in skill ? skill.content : undefined, source);
    assert.equal(skill && 'sha256' in skill ? skill.sha256 : undefined, sha256(source));
  } finally {
    await client.close();
    await closeFixture(fixture);
  }
});
