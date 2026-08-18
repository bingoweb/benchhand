import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseEntityId,
  parseEntityVersion,
  type WorkspaceId,
  type WorkspaceRecord,
} from '@benchhand/contracts';

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

function serviceFor(
  record: WorkspaceRecord | undefined,
  overrides: Partial<ConstructorParameters<typeof FilesystemService>[0]> = {},
): FilesystemService {
  return new FilesystemService({
    resolveWorkspace: async (_workspaceId: WorkspaceId) => record,
    ...overrides,
  });
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function nativeFileDurability(): 'file-and-directory' | 'file-only' {
  return process.platform === 'win32' ? 'file-only' : 'file-and-directory';
}

test('reads a bounded byte range without loading or returning bytes beyond the request', async () => {
  const dir = tempDir('benchhand-filesystem-read-');
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
  const dir = tempDir('benchhand-filesystem-binary-');
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
  const dir = tempDir('benchhand-filesystem-escape-');
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
  const dir = tempDir('benchhand-filesystem-list-');
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
  const dir = tempDir('benchhand-filesystem-search-');
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
  const dir = tempDir('benchhand-filesystem-search-symlink-');
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

  const dir = tempDir('benchhand-filesystem-unavailable-');
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

test('atomically replaces a regular file with a matching hash precondition and preserves POSIX mode where supported', async () => {
  const dir = tempDir('benchhand-filesystem-write-replace-');
  const path = join(dir, 'config.txt');
  writeFileSync(path, 'before\n');
  chmodSync(path, 0o640);

  try {
    const service = serviceFor(await workspaceRecord(dir));
    const result = await service.write({
      workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
      path: 'config.txt',
      content: 'after\n',
      expectedSha256: sha256('before\n'),
    });

    assert.equal(readFileSync(path, 'utf8'), 'after\n');
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o640);
    }
    assert.deepEqual(result, {
      path: 'config.txt',
      created: false,
      previousSha256: sha256('before\n'),
      sha256: sha256('after\n'),
      bytesWritten: 6,
      durability: nativeFileDurability(),
    });
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.benchhand-write-')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hash conflict leaves the final file byte-identical and cleans the temp file', async () => {
  const dir = tempDir('benchhand-filesystem-write-conflict-');
  const path = join(dir, 'config.txt');
  writeFileSync(path, 'current\n');

  try {
    const service = serviceFor(await workspaceRecord(dir));
    await assert.rejects(
      () =>
        service.write({
          workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
          path: 'config.txt',
          content: 'replacement\n',
          expectedSha256: sha256('stale\n'),
        }),
      (error: unknown) => error instanceof FilesystemError && error.code === 'WRITE_CONFLICT',
    );
    assert.equal(readFileSync(path, 'utf8'), 'current\n');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.benchhand-write-')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('null hash is create-only and never overwrites an existing target', async () => {
  const dir = tempDir('benchhand-filesystem-write-create-');
  try {
    const service = serviceFor(await workspaceRecord(dir));
    const workspaceId = parseEntityId('workspace', 'ws_filesystem_fixture');
    const created = await service.write({
      workspaceId,
      path: 'new.txt',
      content: 'first\n',
      expectedSha256: null,
    });
    assert.equal(created.created, true);
    assert.equal(created.previousSha256, null);

    await assert.rejects(
      () =>
        service.write({
          workspaceId,
          path: 'new.txt',
          content: 'second\n',
          expectedSha256: null,
        }),
      (error: unknown) => error instanceof FilesystemError && error.code === 'WRITE_CONFLICT',
    );
    assert.equal(readFileSync(join(dir, 'new.txt'), 'utf8'), 'first\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serializes concurrent writes so one stale precondition loses without partial output', async () => {
  const dir = tempDir('benchhand-filesystem-write-concurrent-');
  const path = join(dir, 'shared.txt');
  writeFileSync(path, 'base\n');

  try {
    const service = serviceFor(await workspaceRecord(dir));
    const workspaceId = parseEntityId('workspace', 'ws_filesystem_fixture');
    const expectedSha256 = sha256('base\n');
    const results = await Promise.allSettled([
      service.write({ workspaceId, path: 'shared.txt', content: 'left\n', expectedSha256 }),
      service.write({ workspaceId, path: 'shared.txt', content: 'right\n', expectedSha256 }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejection = results.find((result) => result.status === 'rejected');
    assert.equal(
      rejection?.status === 'rejected' &&
        rejection.reason instanceof FilesystemError &&
        rejection.reason.code === 'WRITE_CONFLICT',
      true,
    );
    assert.equal(['left\n', 'right\n'].includes(readFileSync(path, 'utf8')), true);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.benchhand-write-')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write rejects symlink targets and parent symlink escape before creating temp files', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = tempDir('benchhand-filesystem-write-symlink-');
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'file-link'));
  symlinkSync(outside, join(root, 'dir-link'));

  try {
    const service = serviceFor(await workspaceRecord(root));
    const workspaceId = parseEntityId('workspace', 'ws_filesystem_fixture');
    await assert.rejects(
      () => service.write({ workspaceId, path: 'file-link', content: 'blocked\n' }),
      (error: unknown) =>
        error instanceof FilesystemError && error.code === 'PATH_SYMLINK_UNSUPPORTED',
    );
    await assert.rejects(
      () => service.write({ workspaceId, path: 'dir-link/new.txt', content: 'blocked\n' }),
      (error: unknown) =>
        error instanceof FilesystemError && error.code === 'PATH_OUTSIDE_WORKSPACE',
    );
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret\n');
    assert.equal(lstatSync(join(root, 'file-link')).isSymbolicLink(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rename failure leaves the final file unchanged and removes the staged temp file', async () => {
  const dir = tempDir('benchhand-filesystem-write-rename-failure-');
  const path = join(dir, 'config.txt');
  writeFileSync(path, 'stable\n');

  try {
    const service = serviceFor(await workspaceRecord(dir), {
      renameFile: async () => {
        const error = new Error('fixture rename failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      },
    });
    await assert.rejects(
      () =>
        service.write({
          workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
          path: 'config.txt',
          content: 'replacement\n',
          expectedSha256: sha256('stable\n'),
        }),
      (error: unknown) => error instanceof FilesystemError && error.code === 'WRITE_FAILED',
    );
    assert.equal(readFileSync(path, 'utf8'), 'stable\n');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.benchhand-write-')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports file-only durability after a committed rename when directory sync is unavailable', async () => {
  const dir = tempDir('benchhand-filesystem-write-dir-sync-');
  const path = join(dir, 'config.txt');
  writeFileSync(path, 'before\n');

  try {
    const service = serviceFor(await workspaceRecord(dir), {
      syncDirectory: async () => {
        throw new Error('fixture directory sync failure after commit');
      },
    });
    const result = await service.write({
      workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
      path: 'config.txt',
      content: 'committed\n',
      expectedSha256: sha256('before\n'),
    });
    assert.equal(readFileSync(path, 'utf8'), 'committed\n');
    assert.equal(result.durability, 'file-only');
    assert.equal(result.sha256, sha256('committed\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create-only commit never overwrites a target that appears after the precondition check', async () => {
  const dir = tempDir('benchhand-filesystem-write-create-race-');
  const path = join(dir, 'new.txt');

  try {
    const service = serviceFor(await workspaceRecord(dir), {
      linkFile: async (stagedPath, targetPath) => {
        writeFileSync(targetPath, 'external-winner\n');
        const { link } = await import('node:fs/promises');
        await link(stagedPath, targetPath);
      },
    });
    await assert.rejects(
      () =>
        service.write({
          workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
          path: 'new.txt',
          content: 'benchhand-loser\n',
          expectedSha256: null,
        }),
      (error: unknown) => error instanceof FilesystemError && error.code === 'WRITE_CONFLICT',
    );
    assert.equal(readFileSync(path, 'utf8'), 'external-winner\n');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.benchhand-write-')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch applies multiple exact non-overlapping edits against one hashed source snapshot', async () => {
  const dir = tempDir('benchhand-filesystem-patch-exact-');
  const path = join(dir, 'config.txt');
  const before = 'alpha = 1\nbeta = 2\ngamma = 3\n';
  const after = 'alpha = 10\nbeta = 2\ngamma = 30\n';
  writeFileSync(path, before);

  try {
    const service = serviceFor(await workspaceRecord(dir));
    const result = await service.patch({
      workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
      path: 'config.txt',
      expectedSha256: sha256(before),
      edits: [
        { oldText: 'alpha = 1', newText: 'alpha = 10' },
        { oldText: 'gamma = 3', newText: 'gamma = 30' },
      ],
    });

    assert.equal(readFileSync(path, 'utf8'), after);
    assert.deepEqual(result, {
      path: 'config.txt',
      previousSha256: sha256(before),
      sha256: sha256(after),
      editsApplied: 2,
      bytesWritten: Buffer.byteLength(after),
      durability: nativeFileDurability(),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch stale hash fails closed with structured evidence and leaves the file byte-identical', async () => {
  const dir = tempDir('benchhand-filesystem-patch-stale-');
  const path = join(dir, 'config.txt');
  const current = 'current\n';
  writeFileSync(path, current);

  try {
    const service = serviceFor(await workspaceRecord(dir));
    await assert.rejects(
      () =>
        service.patch({
          workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
          path: 'config.txt',
          expectedSha256: sha256('stale\n'),
          edits: [{ oldText: 'stale', newText: 'replacement' }],
        }),
      (error: unknown) => {
        if (!(error instanceof FilesystemError) || error.code !== 'PATCH_CONFLICT') return false;
        assert.deepEqual((error as FilesystemError & { details?: unknown }).details, {
          reason: 'sha256_mismatch',
          expectedSha256: sha256('stale\n'),
          actualSha256: sha256(current),
        });
        return true;
      },
    );
    assert.equal(readFileSync(path, 'utf8'), current);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch rejects ambiguous expected text instead of guessing which occurrence to mutate', async () => {
  const dir = tempDir('benchhand-filesystem-patch-ambiguous-');
  const path = join(dir, 'config.txt');
  const before = 'same\nmiddle\nsame\n';
  writeFileSync(path, before);

  try {
    const service = serviceFor(await workspaceRecord(dir));
    await assert.rejects(
      () =>
        service.patch({
          workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
          path: 'config.txt',
          expectedSha256: sha256(before),
          edits: [{ oldText: 'same', newText: 'changed' }],
        }),
      (error: unknown) => {
        if (!(error instanceof FilesystemError) || error.code !== 'PATCH_CONFLICT') return false;
        assert.deepEqual((error as FilesystemError & { details?: unknown }).details, {
          reason: 'ambiguous_match',
          editIndex: 0,
          matchCount: 2,
        });
        return true;
      },
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch rejects missing expected text and overlapping edit spans without partial mutation', async () => {
  const dir = tempDir('benchhand-filesystem-patch-conflicts-');
  const path = join(dir, 'config.txt');
  const before = 'abcdef\n';
  writeFileSync(path, before);

  try {
    const service = serviceFor(await workspaceRecord(dir));
    const workspaceId = parseEntityId('workspace', 'ws_filesystem_fixture');

    await assert.rejects(
      () =>
        service.patch({
          workspaceId,
          path: 'config.txt',
          expectedSha256: sha256(before),
          edits: [{ oldText: 'missing', newText: 'replacement' }],
        }),
      (error: unknown) =>
        error instanceof FilesystemError &&
        error.code === 'PATCH_CONFLICT' &&
        JSON.stringify((error as FilesystemError & { details?: unknown }).details) ===
          JSON.stringify({ reason: 'expected_text_not_found', editIndex: 0, matchCount: 0 }),
    );
    assert.equal(readFileSync(path, 'utf8'), before);

    await assert.rejects(
      () =>
        service.patch({
          workspaceId,
          path: 'config.txt',
          expectedSha256: sha256(before),
          edits: [
            { oldText: 'abcd', newText: 'ABCD' },
            { oldText: 'cdef', newText: 'CDEF' },
          ],
        }),
      (error: unknown) =>
        error instanceof FilesystemError &&
        error.code === 'PATCH_CONFLICT' &&
        JSON.stringify((error as FilesystemError & { details?: unknown }).details) ===
          JSON.stringify({ reason: 'overlapping_edits', editIndex: 1, conflictsWithEditIndex: 0 }),
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent patches with one expected hash allow exactly one commit', async () => {
  const dir = tempDir('benchhand-filesystem-patch-concurrent-');
  const path = join(dir, 'shared.txt');
  const before = 'value=base\n';
  writeFileSync(path, before);

  try {
    const service = serviceFor(await workspaceRecord(dir));
    const workspaceId = parseEntityId('workspace', 'ws_filesystem_fixture');
    const expectedSha256 = sha256(before);
    const results = await Promise.allSettled([
      service.patch({
        workspaceId,
        path: 'shared.txt',
        expectedSha256,
        edits: [{ oldText: 'value=base', newText: 'value=left' }],
      }),
      service.patch({
        workspaceId,
        path: 'shared.txt',
        expectedSha256,
        edits: [{ oldText: 'value=base', newText: 'value=right' }],
      }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof FilesystemError &&
        rejected.reason.code === 'PATCH_CONFLICT',
      true,
    );
    assert.equal(['value=left\n', 'value=right\n'].includes(readFileSync(path, 'utf8')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch rejects binary source content before attempting any mutation', async () => {
  const dir = tempDir('benchhand-filesystem-patch-binary-');
  const path = join(dir, 'binary.bin');
  const before = Buffer.from([0x41, 0x00, 0x42]);
  writeFileSync(path, before);

  try {
    const service = serviceFor(await workspaceRecord(dir));
    await assert.rejects(
      () =>
        service.patch({
          workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
          path: 'binary.bin',
          expectedSha256: sha256(before),
          edits: [{ oldText: 'A', newText: 'B' }],
        }),
      (error: unknown) =>
        error instanceof FilesystemError && error.code === 'PATCH_BINARY_UNSUPPORTED',
    );
    assert.deepEqual(readFileSync(path), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch maps an atomic commit failure to PATCH_FAILED and leaves no partial output or staging file', async () => {
  const dir = tempDir('benchhand-filesystem-patch-rename-failure-');
  const path = join(dir, 'config.txt');
  const before = 'before\n';
  writeFileSync(path, before);

  try {
    const service = serviceFor(await workspaceRecord(dir), {
      renameFile: async () => {
        const error = new Error('fixture patch rename failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      },
    });
    await assert.rejects(
      () =>
        service.patch({
          workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
          path: 'config.txt',
          expectedSha256: sha256(before),
          edits: [{ oldText: 'before', newText: 'after' }],
        }),
      (error: unknown) => error instanceof FilesystemError && error.code === 'PATCH_FAILED',
    );
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.benchhand-write-')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch rejects symlink targets parent symlink escapes and lexical traversal', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = tempDir('benchhand-filesystem-patch-symlink-');
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  const outsideFile = join(outside, 'secret.txt');
  writeFileSync(outsideFile, 'secret\n');
  symlinkSync(outsideFile, join(root, 'file-link'));
  symlinkSync(outside, join(root, 'dir-link'));

  try {
    const service = serviceFor(await workspaceRecord(root));
    const workspaceId = parseEntityId('workspace', 'ws_filesystem_fixture');
    await assert.rejects(
      () =>
        service.patch({
          workspaceId,
          path: 'file-link',
          expectedSha256: sha256('secret\n'),
          edits: [{ oldText: 'secret', newText: 'changed' }],
        }),
      (error: unknown) =>
        error instanceof FilesystemError && error.code === 'PATH_SYMLINK_UNSUPPORTED',
    );
    await assert.rejects(
      () =>
        service.patch({
          workspaceId,
          path: 'dir-link/secret.txt',
          expectedSha256: sha256('secret\n'),
          edits: [{ oldText: 'secret', newText: 'changed' }],
        }),
      (error: unknown) =>
        error instanceof FilesystemError && error.code === 'PATH_OUTSIDE_WORKSPACE',
    );
    await assert.rejects(
      () =>
        service.patch({
          workspaceId,
          path: '../outside/secret.txt',
          expectedSha256: sha256('secret\n'),
          edits: [{ oldText: 'secret', newText: 'changed' }],
        }),
      (error: unknown) =>
        error instanceof FilesystemError && error.code === 'PATH_OUTSIDE_WORKSPACE',
    );
    assert.equal(readFileSync(outsideFile, 'utf8'), 'secret\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch reports file-only durability instead of a false failure after commit when directory sync fails', async () => {
  const dir = tempDir('benchhand-filesystem-patch-dir-sync-');
  const path = join(dir, 'config.txt');
  const before = 'before\n';
  writeFileSync(path, before);

  try {
    const service = serviceFor(await workspaceRecord(dir), {
      syncDirectory: async () => {
        throw new Error('fixture patch directory sync failure after commit');
      },
    });
    const result = await service.patch({
      workspaceId: parseEntityId('workspace', 'ws_filesystem_fixture'),
      path: 'config.txt',
      expectedSha256: sha256(before),
      edits: [{ oldText: 'before', newText: 'after' }],
    });
    assert.equal(readFileSync(path, 'utf8'), 'after\n');
    assert.equal(result.durability, 'file-only');
    assert.equal(result.sha256, sha256('after\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
