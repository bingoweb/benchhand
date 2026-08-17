import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseEntityId,
  parseEntityVersion,
  type WorkspaceId,
  type WorkspaceRecord,
} from '@udmcp/contracts';

import { FilesystemError, FilesystemService } from '../src/index.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function workspaceRecord(
  root: string,
  overrides: Partial<WorkspaceRecord> = {},
): Promise<WorkspaceRecord> {
  const canonicalPath = await realpath(root);
  return {
    workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
    canonicalPath,
    requestedPath: root,
    mode: 'checkout',
    repoRoot: null,
    worktreePath: null,
    baseRef: null,
    branch: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    lastUsedAt: '2026-08-17T00:00:00.000Z',
    ownerInstance: 'daemon_fixture',
    status: 'available',
    metadataVersion: parseEntityVersion(1),
    ...overrides,
  };
}

function serviceFor(record: WorkspaceRecord | undefined): FilesystemService {
  return new FilesystemService({
    resolveWorkspace: async (_workspaceId: WorkspaceId) => record,
  });
}

test('reads a bounded byte range without loading or returning bytes beyond the request', async () => {
  const dir = tempDir('udmcp-filesystem-read-');
  writeFileSync(join(dir, 'hello.txt'), 'hello\nworld\n');

  try {
    const service = serviceFor(await workspaceRecord(dir));
    const first = await service.read({
      workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
      path: 'hello.txt',
      offset: 6,
      maxBytes: 5,
    });
    assert.deepEqual(first, {
      path: 'hello.txt',
      classification: 'text',
      size: 12,
      offset: 6,
      bytesRead: 5,
      eof: false,
      truncated: true,
      content: 'world',
    });

    const rest = await service.read({
      workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
      path: 'hello.txt',
      offset: 6,
      maxBytes: 32,
    });
    assert.equal(rest.content, 'world\n');
    assert.equal(rest.eof, true);
    assert.equal(rest.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifies NUL-bearing and invalid UTF-8 ranges as binary without returning lossy text', async () => {
  const dir = tempDir('udmcp-filesystem-binary-');
  writeFileSync(join(dir, 'nul.bin'), Buffer.from([0x41, 0x00, 0x42]));
  writeFileSync(join(dir, 'invalid.bin'), Buffer.from([0xc3, 0x28]));

  try {
    const service = serviceFor(await workspaceRecord(dir));
    for (const path of ['nul.bin', 'invalid.bin']) {
      const result = await service.read({
        workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
        path,
        maxBytes: 1024,
      });
      assert.equal(result.classification, 'binary');
      assert.equal(result.content, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects lexical traversal and a symlink that escapes the canonical workspace root', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = tempDir('udmcp-filesystem-escape-');
  const root = join(dir, 'root');
  const outside = join(dir, 'outside.txt');
  mkdirSync(root);
  writeFileSync(outside, 'secret\n');
  symlinkSync(outside, join(root, 'escape.txt'));

  try {
    const service = serviceFor(await workspaceRecord(root));
    const workspaceId = parseEntityId('workspace', 'ws_filesystem_fixture');
    for (const path of ['../outside.txt', 'escape.txt']) {
      await assert.rejects(
        () => service.read({ workspaceId, path, maxBytes: 1024 }),
        (error: unknown) =>
          error instanceof FilesystemError && error.code === 'PATH_OUTSIDE_WORKSPACE',
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lists directory entries in deterministic order with opaque cursor pagination', async () => {
  const dir = tempDir('udmcp-filesystem-list-');
  for (const name of ['c.txt', 'a.txt', 'b.txt']) writeFileSync(join(dir, name), name);
  mkdirSync(join(dir, 'dir'));

  try {
    const service = serviceFor(await workspaceRecord(dir));
    const workspaceId = parseEntityId('workspace', 'ws_filesystem_fixture');
    const page1 = await service.list({ workspaceId, path: '.', limit: 2 });
    assert.deepEqual(
      page1.entries.map((entry) => [entry.name, entry.type]),
      [
        ['a.txt', 'file'],
        ['b.txt', 'file'],
      ],
    );
    assert.equal(typeof page1.nextCursor, 'string');
    assert.notEqual(page1.nextCursor, 'b.txt');
    const cursor = page1.nextCursor;
    if (cursor === null) throw new Error('expected a second directory page');

    const page2 = await service.list({
      workspaceId,
      path: '.',
      limit: 2,
      cursor,
    });
    assert.deepEqual(
      page2.entries.map((entry) => [entry.name, entry.type]),
      [
        ['c.txt', 'file'],
        ['dir', 'directory'],
      ],
    );
    assert.equal(page2.nextCursor, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search combines glob and literal text matching with deterministic bounded results', async () => {
  const dir = tempDir('udmcp-filesystem-search-');
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'src', 'b.ts'), 'first\nneedle beta\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'needle alpha\nsecond\nneedle again\n');
  writeFileSync(join(dir, 'src', 'nested', 'c.ts'), 'needle gamma\n');
  writeFileSync(join(dir, 'src', 'skip.js'), 'needle js\n');
  writeFileSync(
    join(dir, 'src', 'binary.ts'),
    Buffer.from([0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]),
  );

  try {
    const service = serviceFor(await workspaceRecord(dir));
    const workspaceId = parseEntityId('workspace', 'ws_filesystem_fixture');
    const result = await service.search({
      workspaceId,
      path: '.',
      glob: 'src/**/*.ts',
      query: 'needle',
      maxResults: 3,
      maxBytes: 16_384,
      maxDepth: 8,
    });

    assert.deepEqual(
      result.matches.map((match) => [match.path, match.line, match.column]),
      [
        ['src/a.ts', 1, 1],
        ['src/a.ts', 3, 1],
        ['src/b.ts', 2, 1],
      ],
    );
    assert.equal(result.truncated, true);
    assert.equal(result.skippedBinary, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not traverse symlink directories during search', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = tempDir('udmcp-filesystem-search-symlink-');
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'needle\n');
  symlinkSync(outside, join(root, 'linked'));

  try {
    const service = serviceFor(await workspaceRecord(root));
    const result = await service.search({
      workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
      path: '.',
      glob: '**/*.txt',
      query: 'needle',
    });
    assert.deepEqual(result.matches, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails closed for unknown or unavailable durable workspaces before filesystem access', async () => {
  const workspaceId = parseEntityId('workspace', 'ws_filesystem_fixture');
  await assert.rejects(
    () => serviceFor(undefined).list({ workspaceId, path: '.' }),
    (error: unknown) => error instanceof FilesystemError && error.code === 'WORKSPACE_NOT_FOUND',
  );

  const dir = tempDir('udmcp-filesystem-unavailable-');
  try {
    const missing = await workspaceRecord(dir, { status: 'missing' });
    await assert.rejects(
      () => serviceFor(missing).list({ workspaceId, path: '.' }),
      (error: unknown) =>
        error instanceof FilesystemError && error.code === 'WORKSPACE_UNAVAILABLE',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
