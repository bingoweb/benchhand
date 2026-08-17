import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

import {
  parseEntityId,
  parseWorkspaceRecord,
  type WorkspaceId,
  type WorkspaceRecord,
  type WorkspaceStatus,
} from '@udmcp/contracts';
import type { SqliteDatabase } from '@udmcp/storage';

const WORKSPACE_REGISTRY_MIGRATION = {
  id: '0002-workspace-registry',
  sql: `
    CREATE TABLE workspace_registry (
      workspace_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL,
      requested_path TEXT NOT NULL,
      filesystem_identity TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode = 'checkout'),
      repo_root TEXT,
      worktree_path TEXT,
      base_ref TEXT,
      branch TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      owner_instance TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('available', 'missing', 'inaccessible', 'invalid')
      ),
      metadata_version INTEGER NOT NULL CHECK (metadata_version >= 1),
      UNIQUE(canonical_path, filesystem_identity, mode)
    ) STRICT;

    CREATE INDEX workspace_registry_status_idx
      ON workspace_registry(status);
  `,
} as const;

type WorkspaceRow = {
  workspace_id: string;
  canonical_path: string;
  requested_path: string;
  filesystem_identity: string;
  mode: string;
  repo_root: string | null;
  worktree_path: string | null;
  base_ref: string | null;
  branch: string | null;
  created_at: string;
  last_used_at: string;
  owner_instance: string | null;
  status: string;
  metadata_version: number;
} & Record<string, unknown>;

export interface WorkspaceRegistryOptions {
  ownerInstance?: string;
  now?: () => Date;
  createWorkspaceId?: () => WorkspaceId;
}

export class WorkspaceRegistryError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = 'WorkspaceRegistryError';
    this.code = code;
    this.path = path;
  }
}

export class WorkspaceRegistry {
  readonly #database: SqliteDatabase;
  readonly #ownerInstance: string | null;
  readonly #now: () => Date;
  readonly #createWorkspaceId: () => WorkspaceId;

  constructor(database: SqliteDatabase, options: WorkspaceRegistryOptions = {}) {
    if (options.ownerInstance !== undefined && options.ownerInstance.length === 0) {
      throw new TypeError('ownerInstance must not be empty');
    }

    this.#database = database;
    this.#ownerInstance = options.ownerInstance ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#createWorkspaceId =
      options.createWorkspaceId ?? (() => parseEntityId('workspace', `ws_${randomUUID()}`));
    this.#database.applyMigrations([WORKSPACE_REGISTRY_MIGRATION]);
  }

  async open(requestedPath: string): Promise<WorkspaceRecord> {
    if (requestedPath.length === 0) {
      throw new TypeError('workspace path must not be empty');
    }

    const absoluteRequestedPath = resolve(requestedPath);
    const { canonicalPath, filesystemIdentity } =
      await resolveWorkspaceDirectory(absoluteRequestedPath);
    const repoRoot = await findRepoRoot(canonicalPath);
    const timestamp = this.#now().toISOString();
    const candidateId = this.#createWorkspaceId();

    const row = this.#database.get<WorkspaceRow>(
      `
        INSERT INTO workspace_registry(
          workspace_id,
          canonical_path,
          requested_path,
          filesystem_identity,
          mode,
          repo_root,
          worktree_path,
          base_ref,
          branch,
          created_at,
          last_used_at,
          owner_instance,
          status,
          metadata_version
        ) VALUES (?, ?, ?, ?, 'checkout', ?, NULL, NULL, NULL, ?, ?, ?, 'available', 1)
        ON CONFLICT(canonical_path, filesystem_identity, mode) DO UPDATE SET
          requested_path = excluded.requested_path,
          repo_root = excluded.repo_root,
          last_used_at = excluded.last_used_at,
          owner_instance = excluded.owner_instance,
          status = 'available',
          metadata_version = workspace_registry.metadata_version + 1
        RETURNING *
      `,
      [
        candidateId,
        canonicalPath,
        absoluteRequestedPath,
        filesystemIdentity,
        repoRoot,
        timestamp,
        timestamp,
        this.#ownerInstance,
      ],
    );

    if (row === undefined) {
      throw new Error('workspace registry upsert returned no row');
    }

    return rowToWorkspaceRecord(row);
  }

  async get(workspaceId: WorkspaceId): Promise<WorkspaceRecord | undefined> {
    const existing = this.#read(workspaceId);
    if (existing === undefined) return undefined;

    const row = this.#database.get<WorkspaceRow>(
      'SELECT * FROM workspace_registry WHERE workspace_id = ?',
      [workspaceId],
    );
    if (row === undefined) return undefined;

    const currentStatus = await inspectPersistedWorkspacePath(
      existing.canonicalPath,
      row.filesystem_identity,
    );
    if (currentStatus !== existing.status) {
      const result = this.#database.run(
        `
          UPDATE workspace_registry
          SET status = ?,
              metadata_version = metadata_version + 1
          WHERE workspace_id = ?
        `,
        [currentStatus, workspaceId],
      );
      if (result.changes !== 1) {
        throw new Error(`workspace ${workspaceId} disappeared during revalidation`);
      }
      return this.#read(workspaceId);
    }

    return existing;
  }

  #read(workspaceId: WorkspaceId): WorkspaceRecord | undefined {
    const row = this.#database.get<WorkspaceRow>(
      `
        SELECT
          workspace_id,
          canonical_path,
          requested_path,
          filesystem_identity,
          mode,
          repo_root,
          worktree_path,
          base_ref,
          branch,
          created_at,
          last_used_at,
          owner_instance,
          status,
          metadata_version
        FROM workspace_registry
        WHERE workspace_id = ?
      `,
      [workspaceId],
    );
    return row === undefined ? undefined : rowToWorkspaceRecord(row);
  }
}

async function resolveWorkspaceDirectory(
  requestedPath: string,
): Promise<{ canonicalPath: string; filesystemIdentity: string }> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch (error) {
    throw classifyOpenPathError(requestedPath, error);
  }

  try {
    const stats = await stat(canonicalPath, { bigint: true });
    if (!stats.isDirectory()) {
      throw new WorkspaceRegistryError(
        'WORKSPACE_PATH_NOT_DIRECTORY',
        requestedPath,
        `workspace path is not a directory: ${requestedPath}`,
      );
    }
    return {
      canonicalPath,
      filesystemIdentity: filesystemIdentityFromStats(stats),
    };
  } catch (error) {
    if (error instanceof WorkspaceRegistryError) throw error;
    throw classifyOpenPathError(requestedPath, error);
  }
}

async function findRepoRoot(canonicalPath: string): Promise<string | null> {
  const filesystemRoot = parse(canonicalPath).root;
  let current = canonicalPath;

  for (;;) {
    try {
      await lstat(join(current, '.git'));
      return current;
    } catch (error) {
      if (!hasErrnoCode(error, 'ENOENT') && !hasErrnoCode(error, 'ENOTDIR')) {
        if (hasErrnoCode(error, 'EACCES') || hasErrnoCode(error, 'EPERM')) return null;
        throw error;
      }
    }

    if (current === filesystemRoot) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function inspectPersistedWorkspacePath(
  canonicalPath: string,
  expectedFilesystemIdentity: string,
): Promise<WorkspaceStatus> {
  try {
    const stats = await stat(canonicalPath, { bigint: true });
    if (!stats.isDirectory()) return 'invalid';
    return filesystemIdentityFromStats(stats) === expectedFilesystemIdentity
      ? 'available'
      : 'invalid';
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT') || hasErrnoCode(error, 'ENOTDIR')) return 'missing';
    if (hasErrnoCode(error, 'EACCES') || hasErrnoCode(error, 'EPERM')) return 'inaccessible';
    throw error;
  }
}

function filesystemIdentityFromStats(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

function classifyOpenPathError(path: string, error: unknown): WorkspaceRegistryError {
  if (hasErrnoCode(error, 'ENOENT')) {
    return new WorkspaceRegistryError(
      'WORKSPACE_PATH_NOT_FOUND',
      path,
      `workspace path does not exist: ${path}`,
    );
  }
  if (hasErrnoCode(error, 'EACCES') || hasErrnoCode(error, 'EPERM')) {
    return new WorkspaceRegistryError(
      'WORKSPACE_PATH_INACCESSIBLE',
      path,
      `workspace path is inaccessible: ${path}`,
    );
  }
  if (hasErrnoCode(error, 'ENOTDIR')) {
    return new WorkspaceRegistryError(
      'WORKSPACE_PATH_NOT_DIRECTORY',
      path,
      `workspace path is not a directory: ${path}`,
    );
  }
  if (error instanceof Error) {
    return new WorkspaceRegistryError('WORKSPACE_PATH_FAILURE', path, error.message);
  }
  return new WorkspaceRegistryError(
    'WORKSPACE_PATH_FAILURE',
    path,
    `workspace path could not be inspected: ${path}`,
  );
}

function hasErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function rowToWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return parseWorkspaceRecord({
    workspaceId: row.workspace_id,
    canonicalPath: row.canonical_path,
    requestedPath: row.requested_path,
    mode: row.mode,
    repoRoot: row.repo_root,
    worktreePath: row.worktree_path,
    baseRef: row.base_ref,
    branch: row.branch,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    ownerInstance: row.owner_instance,
    status: row.status,
    metadataVersion: row.metadata_version,
  });
}
