import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openSqliteDatabase } from '@benchhand/storage';

import { WorkspaceRegistry, WorkspaceRegistryError } from '../src/index.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createRepository(root: string): string {
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

function expectedOwnershipKey(repo: string, baseCommit: string): string {
  const stats = statSync(repo, { bigint: true });
  const filesystemIdentity = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
  return createHash('sha256')
    .update(filesystemIdentity)
    .update('\0')
    .update(baseCommit)
    .digest('hex')
    .slice(0, 20);
}

test('creates and deterministically reuses a managed worktree without touching dirty main checkout', async () => {
  const dir = tempDir('benchhand-managed-worktree-');
  const repo = createRepository(dir);
  const worktreeRoot = join(dir, 'managed');
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  writeFileSync(join(repo, 'tracked.txt'), 'dirty-main\n');
  writeFileSync(join(repo, 'untracked.txt'), 'leave-me\n');
  const beforeStatus = git(repo, ['status', '--porcelain=v1', '-z']);
  const beforeHead = git(repo, ['rev-parse', 'HEAD']).trim();
  const beforeTracked = readFileSync(join(repo, 'tracked.txt'), 'utf8');
  const beforeUntracked = readFileSync(join(repo, 'untracked.txt'), 'utf8');

  try {
    const registry = new WorkspaceRegistry(db, {
      ownerInstance: 'daemon_worktree',
      worktreeRoot,
    });
    const opened = await registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' });

    assert.equal(opened.mode, 'worktree');
    assert.equal(opened.repoRoot, await realpath(repo));
    assert.equal(opened.worktreePath, opened.canonicalPath);
    assert.match(opened.baseRef ?? '', /^[0-9a-f]{40,64}$/);
    assert.match(opened.branch ?? '', /^benchhand\/[0-9a-f]{20}$/);
    assert.equal(opened.ownerInstance, 'daemon_worktree');
    assert.equal(readFileSync(join(opened.canonicalPath, 'tracked.txt'), 'utf8'), 'committed\n');

    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), beforeHead);
    assert.equal(git(repo, ['status', '--porcelain=v1', '-z']), beforeStatus);
    assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), beforeTracked);
    assert.equal(readFileSync(join(repo, 'untracked.txt'), 'utf8'), beforeUntracked);

    const reopened = await registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' });
    assert.equal(reopened.workspaceId, opened.workspaceId);
    assert.equal(reopened.canonicalPath, opened.canonicalPath);
    assert.equal(reopened.baseRef, opened.baseRef);
    assert.equal(reopened.branch, opened.branch);
    assert.equal(reopened.metadataVersion, opened.metadataVersion + 1);

    assert.deepEqual(
      db
        .all<{ action: string }>('SELECT action FROM worktree_cleanup_journal ORDER BY event_id')
        .map((row) => row.action),
      ['create-intent', 'created'],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolves symbolic base refs to immutable commits and creates a new ownership after HEAD moves', async () => {
  const dir = tempDir('benchhand-worktree-base-ref-');
  const repo = createRepository(dir);
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  try {
    const registry = new WorkspaceRegistry(db, { worktreeRoot: join(dir, 'managed') });
    const first = await registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' });

    writeFileSync(join(repo, 'second.txt'), 'second\n');
    git(repo, ['add', 'second.txt']);
    git(repo, ['commit', '-q', '-m', 'second']);
    const secondHead = git(repo, ['rev-parse', 'HEAD']).trim();
    const second = await registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' });

    assert.notEqual(second.workspaceId, first.workspaceId);
    assert.notEqual(second.canonicalPath, first.canonicalPath);
    assert.notEqual(second.baseRef, first.baseRef);
    assert.equal(second.baseRef, secondHead);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reuses a managed worktree across registry restart and transfers owner metadata', async () => {
  const dir = tempDir('benchhand-worktree-restart-');
  const repo = createRepository(dir);
  const databasePath = join(dir, 'state.sqlite');
  const worktreeRoot = join(dir, 'managed');
  const firstDb = openSqliteDatabase(databasePath);

  try {
    const firstRegistry = new WorkspaceRegistry(firstDb, {
      ownerInstance: 'daemon_first',
      worktreeRoot,
    });
    const first = await firstRegistry.open(repo, { mode: 'worktree', baseRef: 'HEAD' });
    firstDb.close();

    const secondDb = openSqliteDatabase(databasePath);
    try {
      const secondRegistry = new WorkspaceRegistry(secondDb, {
        ownerInstance: 'daemon_second',
        worktreeRoot,
      });
      const second = await secondRegistry.open(repo, { mode: 'worktree', baseRef: 'HEAD' });
      assert.equal(second.workspaceId, first.workspaceId);
      assert.equal(second.canonicalPath, first.canonicalPath);
      assert.equal(second.ownerInstance, 'daemon_second');
      assert.equal(second.metadataVersion, first.metadataVersion + 1);
    } finally {
      secondDb.close();
    }
  } finally {
    firstDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects invalid worktree requests without mutating a foreign occupied managed path', async () => {
  const dir = tempDir('benchhand-worktree-errors-');
  const repo = createRepository(dir);
  const nonRepo = join(dir, 'not-a-repo');
  const worktreeRoot = join(dir, 'managed');
  mkdirSync(nonRepo);
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  try {
    const registry = new WorkspaceRegistry(db, { worktreeRoot });

    await assert.rejects(
      () => registry.open(repo, { mode: 'checkout', baseRef: 'HEAD' }),
      (error: unknown) =>
        error instanceof WorkspaceRegistryError &&
        error.code === 'WORKSPACE_BASE_REF_REQUIRES_WORKTREE',
    );
    await assert.rejects(
      () => registry.open(nonRepo, { mode: 'worktree' }),
      (error: unknown) =>
        error instanceof WorkspaceRegistryError && error.code === 'WORKTREE_REPO_REQUIRED',
    );
    await assert.rejects(
      () => registry.open(repo, { mode: 'worktree', baseRef: 'does-not-exist' }),
      (error: unknown) =>
        error instanceof WorkspaceRegistryError && error.code === 'WORKTREE_BASE_REF_INVALID',
    );

    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const ownershipKey = expectedOwnershipKey(await realpath(repo), head);
    const occupied = join(worktreeRoot, ownershipKey);
    mkdirSync(occupied, { recursive: true });
    const marker = join(occupied, 'foreign.txt');
    writeFileSync(marker, 'do-not-touch\n');

    await assert.rejects(
      () => registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' }),
      (error: unknown) =>
        error instanceof WorkspaceRegistryError && error.code === 'WORKTREE_PATH_OCCUPIED',
    );
    assert.equal(readFileSync(marker, 'utf8'), 'do-not-touch\n');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconciles a Benchhand-owned worktree created before durable registry finalization', async () => {
  const dir = tempDir('benchhand-worktree-reconcile-create-');
  const repo = createRepository(dir);
  const worktreeRoot = join(dir, 'managed');
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  try {
    const registry = new WorkspaceRegistry(db, { worktreeRoot });
    const repoRoot = await realpath(repo);
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const ownershipKey = expectedOwnershipKey(repoRoot, head);
    const worktreePath = join(worktreeRoot, ownershipKey);
    const branch = `benchhand/${ownershipKey}`;
    mkdirSync(worktreeRoot, { recursive: true });

    db.run(
      `
        INSERT INTO worktree_cleanup_journal(
          ownership_key,
          workspace_id,
          action,
          details_json
        ) VALUES (?, NULL, 'create-intent', ?)
      `,
      [
        ownershipKey,
        JSON.stringify({
          repoRoot,
          requestedBaseRef: 'HEAD',
          baseCommit: head,
          branch,
          worktreePath,
        }),
      ],
    );
    git(repo, [
      'worktree',
      'add',
      '--lock',
      '--reason',
      `benchhand:${ownershipKey}`,
      '-b',
      branch,
      worktreePath,
      head,
    ]);

    const reconciled = await registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' });
    assert.equal(reconciled.mode, 'worktree');
    assert.equal(reconciled.canonicalPath, await realpath(worktreePath));
    assert.equal(reconciled.baseRef, head);
    assert.equal(reconciled.branch, branch);

    assert.deepEqual(
      db
        .all<{ action: string }>(
          'SELECT action FROM worktree_cleanup_journal WHERE ownership_key = ? ORDER BY event_id',
          [ownershipKey],
        )
        .map((row) => row.action),
      ['create-intent', 'reconciled'],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marks a missing managed worktree cleanup-required instead of blindly recreating it', async () => {
  const dir = tempDir('benchhand-worktree-missing-managed-');
  const repo = createRepository(dir);
  const worktreeRoot = join(dir, 'managed');
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  try {
    const registry = new WorkspaceRegistry(db, { worktreeRoot });
    const opened = await registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' });
    rmSync(opened.canonicalPath, { recursive: true, force: true });

    const stale = await registry.get(opened.workspaceId);
    assert.equal(stale?.status, 'missing');

    await assert.rejects(
      () => registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' }),
      (error: unknown) =>
        error instanceof WorkspaceRegistryError && error.code === 'WORKTREE_CLEANUP_REQUIRED',
    );

    assert.equal(
      db.get<{ status: string }>('SELECT status FROM managed_worktrees WHERE workspace_id = ?', [
        opened.workspaceId,
      ])?.status,
      'cleanup-required',
    );
    assert.deepEqual(
      db
        .all<{ action: string }>('SELECT action FROM worktree_cleanup_journal ORDER BY event_id')
        .map((row) => row.action),
      ['create-intent', 'created', 'cleanup-intent'],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coalesces concurrent worktree opens from independent registry connections', async () => {
  const dir = tempDir('benchhand-worktree-concurrent-');
  const repo = createRepository(dir);
  const databasePath = join(dir, 'state.sqlite');
  const worktreeRoot = join(dir, 'managed');
  const dbA = openSqliteDatabase(databasePath, { busyTimeoutMs: 2_000 });
  const dbB = openSqliteDatabase(databasePath, { busyTimeoutMs: 2_000 });

  try {
    const registryA = new WorkspaceRegistry(dbA, {
      ownerInstance: 'daemon_a',
      worktreeRoot,
    });
    const registryB = new WorkspaceRegistry(dbB, {
      ownerInstance: 'daemon_b',
      worktreeRoot,
    });

    const [a, b] = await Promise.all([
      registryA.open(repo, { mode: 'worktree', baseRef: 'HEAD' }),
      registryB.open(repo, { mode: 'worktree', baseRef: 'HEAD' }),
    ]);

    assert.equal(a.workspaceId, b.workspaceId);
    assert.equal(a.canonicalPath, b.canonicalPath);
    assert.equal(
      dbA.get<{ count: number }>('SELECT COUNT(*) AS count FROM managed_worktrees')?.count,
      1,
    );
  } finally {
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a managed worktree root inside the source repository before touching the dirty checkout', async () => {
  const dir = tempDir('benchhand-worktree-root-conflict-');
  const repo = createRepository(dir);
  const worktreeRoot = join(repo, '.benchhand-worktrees');
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));
  writeFileSync(join(repo, 'tracked.txt'), 'dirty-main\n');
  writeFileSync(join(repo, 'untracked.txt'), 'leave-me\n');
  const beforeStatus = git(repo, ['status', '--porcelain=v1', '-z']);

  try {
    const registry = new WorkspaceRegistry(db, { worktreeRoot });
    await assert.rejects(
      () => registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' }),
      (error: unknown) =>
        error instanceof WorkspaceRegistryError && error.code === 'WORKTREE_ROOT_CONFLICT',
    );
    assert.equal(git(repo, ['status', '--porcelain=v1', '-z']), beforeStatus);
    assert.equal(existsSync(worktreeRoot), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocks an orphaned Benchhand branch from a partial create instead of resetting or reusing it blindly', async () => {
  const dir = tempDir('benchhand-worktree-orphan-branch-');
  const repo = createRepository(dir);
  const worktreeRoot = join(dir, 'managed');
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  try {
    const registry = new WorkspaceRegistry(db, { worktreeRoot });
    const repoRoot = await realpath(repo);
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const ownershipKey = expectedOwnershipKey(repoRoot, head);
    const worktreePath = join(worktreeRoot, ownershipKey);
    const branch = `benchhand/${ownershipKey}`;

    db.run(
      `
        INSERT INTO worktree_cleanup_journal(
          ownership_key,
          workspace_id,
          action,
          details_json
        ) VALUES (?, NULL, 'create-intent', ?)
      `,
      [
        ownershipKey,
        JSON.stringify({
          repoRoot,
          requestedBaseRef: 'HEAD',
          baseCommit: head,
          branch,
          worktreePath,
        }),
      ],
    );
    git(repo, ['branch', branch, head]);

    await assert.rejects(
      () => registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' }),
      (error: unknown) =>
        error instanceof WorkspaceRegistryError && error.code === 'WORKTREE_CLEANUP_REQUIRED',
    );

    assert.equal(git(repo, ['rev-parse', `refs/heads/${branch}^{commit}`]).trim(), head);
    assert.equal(existsSync(worktreePath), false);
    assert.deepEqual(
      db
        .all<{ action: string }>(
          'SELECT action FROM worktree_cleanup_journal WHERE ownership_key = ? ORDER BY event_id',
          [ownershipKey],
        )
        .map((row) => row.action),
      ['create-intent', 'cleanup-intent'],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('treats a deterministic branch collision without durable ownership evidence as foreign', async () => {
  const dir = tempDir('benchhand-worktree-foreign-branch-');
  const repo = createRepository(dir);
  const worktreeRoot = join(dir, 'managed');
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  try {
    const registry = new WorkspaceRegistry(db, { worktreeRoot });
    const repoRoot = await realpath(repo);
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const ownershipKey = expectedOwnershipKey(repoRoot, head);
    const branch = `benchhand/${ownershipKey}`;
    git(repo, ['branch', branch, head]);

    await assert.rejects(
      () => registry.open(repo, { mode: 'worktree', baseRef: 'HEAD' }),
      (error: unknown) =>
        error instanceof WorkspaceRegistryError && error.code === 'WORKTREE_BRANCH_OCCUPIED',
    );

    assert.equal(git(repo, ['rev-parse', `refs/heads/${branch}^{commit}`]).trim(), head);
    assert.equal(
      db.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM worktree_cleanup_journal WHERE ownership_key = ?',
        [ownershipKey],
      )?.count,
      0,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
