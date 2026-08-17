import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openSqliteDatabase } from '@udmcp/storage';

import { WorkspaceRegistry, WorkspaceRegistryError } from '../src/index.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('opens a checkout workspace with canonical path, repo root and durable metadata', async () => {
  const dir = tempDir('udmcp-workspace-open-');
  const repo = join(dir, 'repo');
  const nested = join(repo, 'packages', 'app');
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(nested, { recursive: true });

  try {
    const registry = new WorkspaceRegistry(db, { ownerInstance: 'daemon_a' });
    const workspace = await registry.open(nested);

    assert.equal(workspace.workspaceId.startsWith('ws_'), true);
    assert.equal(workspace.canonicalPath, await realpath(nested));
    assert.equal(workspace.requestedPath, nested);
    assert.equal(workspace.mode, 'checkout');
    assert.equal(workspace.repoRoot, await realpath(repo));
    assert.equal(workspace.worktreePath, null);
    assert.equal(workspace.baseRef, null);
    assert.equal(workspace.branch, null);
    assert.equal(workspace.ownerInstance, 'daemon_a');
    assert.equal(workspace.status, 'available');
    assert.equal(workspace.metadataVersion, 1);
    assert.equal(workspace.createdAt, workspace.lastUsedAt);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolves symlink aliases to one stable workspace id and treats a retargeted alias as a new workspace', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = tempDir('udmcp-workspace-symlink-');
  const targetA = join(dir, 'target-a');
  const targetB = join(dir, 'target-b');
  const alias = join(dir, 'current');
  mkdirSync(targetA);
  mkdirSync(targetB);
  symlinkSync(targetA, alias, 'dir');
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  try {
    const registry = new WorkspaceRegistry(db);
    const viaAlias = await registry.open(alias);
    const viaRealPath = await registry.open(targetA);

    assert.equal(viaAlias.workspaceId, viaRealPath.workspaceId);
    assert.equal(viaAlias.canonicalPath, await realpath(targetA));

    unlinkSync(alias);
    symlinkSync(targetB, alias, 'dir');
    const retargeted = await registry.open(alias);
    const originalAgain = await registry.open(targetA);

    assert.notEqual(retargeted.workspaceId, viaAlias.workspaceId);
    assert.equal(retargeted.canonicalPath, await realpath(targetB));
    assert.equal(originalAgain.workspaceId, viaAlias.workspaceId);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reuses the same durable workspace id from a new registry instance and owner', async () => {
  const dir = tempDir('udmcp-workspace-reuse-');
  const project = join(dir, 'project');
  const databasePath = join(dir, 'state.sqlite');
  mkdirSync(project);

  try {
    const firstDb = openSqliteDatabase(databasePath);
    const first = await new WorkspaceRegistry(firstDb, { ownerInstance: 'daemon_a' }).open(project);
    firstDb.close();

    const secondDb = openSqliteDatabase(databasePath);
    try {
      const second = await new WorkspaceRegistry(secondDb, { ownerInstance: 'daemon_b' }).open(
        project,
      );
      assert.equal(second.workspaceId, first.workspaceId);
      assert.equal(second.createdAt, first.createdAt);
      assert.equal(second.ownerInstance, 'daemon_b');
      assert.equal(second.metadataVersion, first.metadataVersion + 1);
    } finally {
      secondDb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic duplicate open returns one workspace id across two registry connections', async () => {
  const dir = tempDir('udmcp-workspace-race-');
  const project = join(dir, 'project');
  const databasePath = join(dir, 'state.sqlite');
  mkdirSync(project);
  const firstDb = openSqliteDatabase(databasePath);
  const secondDb = openSqliteDatabase(databasePath);

  try {
    const firstRegistry = new WorkspaceRegistry(firstDb, { ownerInstance: 'daemon_a' });
    const secondRegistry = new WorkspaceRegistry(secondDb, { ownerInstance: 'daemon_b' });
    const [first, second] = await Promise.all([
      firstRegistry.open(project),
      secondRegistry.open(project),
    ]);

    assert.equal(first.workspaceId, second.workspaceId);
    assert.equal(
      firstDb.get<{ count: number }>('SELECT COUNT(*) AS count FROM workspace_registry')?.count,
      1,
    );
  } finally {
    firstDb.close();
    secondDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps a deleted workspace handle durable and marks it missing', async () => {
  const dir = tempDir('udmcp-workspace-missing-');
  const project = join(dir, 'project');
  mkdirSync(project);
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  try {
    const registry = new WorkspaceRegistry(db);
    const opened = await registry.open(project);
    rmSync(project, { recursive: true, force: true });

    const refreshed = await registry.get(opened.workspaceId);
    assert.equal(refreshed?.workspaceId, opened.workspaceId);
    assert.equal(refreshed?.status, 'missing');
    assert.equal(refreshed?.metadataVersion, opened.metadataVersion + 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never rebinds an existing workspace handle when its canonical path is replaced', async () => {
  const dir = tempDir('udmcp-workspace-replaced-path-');
  const project = join(dir, 'project');
  const replacement = join(dir, 'replacement');
  mkdirSync(project);
  mkdirSync(replacement);
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  try {
    const registry = new WorkspaceRegistry(db);
    const original = await registry.open(project);

    rmSync(project, { recursive: true, force: true });
    renameSync(replacement, project);

    const reopened = await registry.open(project);
    assert.notEqual(reopened.workspaceId, original.workspaceId);

    const stale = await registry.get(original.workspaceId);
    assert.equal(stale?.workspaceId, original.workspaceId);
    assert.equal(stale?.status, 'invalid');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects missing paths, regular files and inaccessible paths with distinct errors', async () => {
  const dir = tempDir('udmcp-workspace-errors-');
  const file = join(dir, 'file.txt');
  const blocked = join(dir, 'blocked');
  const blockedProject = join(blocked, 'project');
  writeFileSync(file, 'fixture');
  mkdirSync(blockedProject, { recursive: true });
  const db = openSqliteDatabase(join(dir, 'state.sqlite'));

  try {
    const registry = new WorkspaceRegistry(db);
    await assert.rejects(
      () => registry.open(join(dir, 'missing')),
      (error: unknown) =>
        error instanceof WorkspaceRegistryError && error.code === 'WORKSPACE_PATH_NOT_FOUND',
    );
    await assert.rejects(
      () => registry.open(file),
      (error: unknown) =>
        error instanceof WorkspaceRegistryError && error.code === 'WORKSPACE_PATH_NOT_DIRECTORY',
    );

    if (process.platform !== 'win32') {
      chmodSync(blocked, 0o000);
      try {
        await assert.rejects(
          () => registry.open(blockedProject),
          (error: unknown) =>
            error instanceof WorkspaceRegistryError && error.code === 'WORKSPACE_PATH_INACCESSIBLE',
        );
      } finally {
        chmodSync(blocked, 0o700);
      }
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
