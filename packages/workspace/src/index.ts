import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import {
  parseEntityId,
  parseWorkspaceRecord,
  type WorkspaceId,
  type WorkspaceMode,
  type WorkspaceRecord,
  type WorkspaceStatus,
} from '@benchhand/contracts';
import type { SqliteDatabase } from '@benchhand/storage';

import {
  createLockedWorktree,
  GitWorktreeError,
  type GitWorktreeInfo,
  listGitWorktrees,
  readLocalBranchCommit,
  resolveGitCommit,
} from './git-worktree.js';

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

const WORKTREE_MANAGER_MIGRATION = {
  id: '0003-worktree-manager',
  sql: `
    DROP INDEX workspace_registry_status_idx;
    ALTER TABLE workspace_registry RENAME TO workspace_registry_checkout_v1;

    CREATE TABLE workspace_registry (
      workspace_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL,
      requested_path TEXT NOT NULL,
      filesystem_identity TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('checkout', 'worktree')),
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
    )
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
    FROM workspace_registry_checkout_v1;

    DROP TABLE workspace_registry_checkout_v1;

    CREATE INDEX workspace_registry_status_idx
      ON workspace_registry(status);

    CREATE TABLE managed_worktrees (
      ownership_key TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL UNIQUE
        REFERENCES workspace_registry(workspace_id) ON DELETE CASCADE,
      source_repo_root TEXT NOT NULL,
      source_filesystem_identity TEXT NOT NULL,
      requested_base_ref TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      branch TEXT NOT NULL UNIQUE,
      worktree_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'cleanup-required')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_filesystem_identity, base_commit)
    ) STRICT;

    CREATE TABLE worktree_cleanup_journal (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ownership_key TEXT NOT NULL,
      workspace_id TEXT,
      action TEXT NOT NULL CHECK (
        action IN (
          'create-intent',
          'created',
          'create-failed',
          'cleanup-intent',
          'cleaned',
          'cleanup-failed',
          'reconciled'
        )
      ),
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE INDEX worktree_cleanup_journal_ownership_idx
      ON worktree_cleanup_journal(ownership_key, event_id);
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

type ManagedWorktreeRow = {
  ownership_key: string;
  workspace_id: string;
  source_repo_root: string;
  source_filesystem_identity: string;
  requested_base_ref: string;
  base_commit: string;
  branch: string;
  worktree_path: string;
  status: string;
  created_at: string;
  updated_at: string;
} & Record<string, unknown>;

interface ManagedWorktreeRegistration {
  ownershipKey: string;
  absoluteRequestedPath: string;
  repoRoot: string;
  sourceFilesystemIdentity: string;
  requestedBaseRef: string;
  baseCommit: string;
  branch: string;
  worktreePath: string;
}

export interface WorkspaceRegistryOptions {
  ownerInstance?: string;
  worktreeRoot?: string;
  now?: () => Date;
  createWorkspaceId?: () => WorkspaceId;
}

export interface WorkspaceOpenOptions {
  mode?: WorkspaceMode;
  baseRef?: string;
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
  readonly #worktreeRoot: string | null;
  readonly #now: () => Date;
  readonly #createWorkspaceId: () => WorkspaceId;

  constructor(database: SqliteDatabase, options: WorkspaceRegistryOptions = {}) {
    if (options.ownerInstance !== undefined && options.ownerInstance.length === 0) {
      throw new TypeError('ownerInstance must not be empty');
    }

    this.#database = database;
    this.#ownerInstance = options.ownerInstance ?? null;
    this.#worktreeRoot = options.worktreeRoot === undefined ? null : resolve(options.worktreeRoot);
    this.#now = options.now ?? (() => new Date());
    this.#createWorkspaceId =
      options.createWorkspaceId ?? (() => parseEntityId('workspace', `ws_${randomUUID()}`));
    this.#database.applyMigrations([WORKSPACE_REGISTRY_MIGRATION, WORKTREE_MANAGER_MIGRATION]);
  }

  async open(requestedPath: string, options: WorkspaceOpenOptions = {}): Promise<WorkspaceRecord> {
    if (requestedPath.length === 0) {
      throw new TypeError('workspace path must not be empty');
    }

    const mode = options.mode ?? 'checkout';
    if (mode === 'worktree') {
      return this.#openWorktree(requestedPath, options.baseRef ?? 'HEAD');
    }
    if (options.baseRef !== undefined) {
      throw new WorkspaceRegistryError(
        'WORKSPACE_BASE_REF_REQUIRES_WORKTREE',
        requestedPath,
        'baseRef is only valid for worktree mode',
      );
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

  async #openWorktree(requestedPath: string, requestedBaseRef: string): Promise<WorkspaceRecord> {
    const absoluteRequestedPath = resolve(requestedPath);
    const { canonicalPath: sourcePath } = await resolveWorkspaceDirectory(absoluteRequestedPath);
    const repoRoot = await findRepoRoot(sourcePath);
    if (repoRoot === null) {
      throw new WorkspaceRegistryError(
        'WORKTREE_REPO_REQUIRED',
        absoluteRequestedPath,
        `worktree mode requires a Git repository: ${absoluteRequestedPath}`,
      );
    }
    if (this.#worktreeRoot === null) {
      throw new WorkspaceRegistryError(
        'WORKTREE_ROOT_UNCONFIGURED',
        absoluteRequestedPath,
        'worktree mode requires a configured managed worktree root',
      );
    }

    const managedRoot = await canonicalizePotentialPath(this.#worktreeRoot);
    if (isSameOrDescendantPath(repoRoot, managedRoot)) {
      throw new WorkspaceRegistryError(
        'WORKTREE_ROOT_CONFLICT',
        managedRoot,
        `managed worktree root must not be inside the source repository: ${managedRoot}`,
      );
    }

    const sourceStats = await stat(repoRoot, { bigint: true });
    const sourceFilesystemIdentity = filesystemIdentityFromStats(sourceStats);
    let baseCommit: string;
    try {
      baseCommit = await resolveGitCommit(repoRoot, requestedBaseRef);
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        throw new WorkspaceRegistryError(error.code, requestedBaseRef, error.message);
      }
      throw error;
    }

    const ownershipKey = worktreeOwnershipKey(sourceFilesystemIdentity, baseCommit);
    const existing = this.#database.get<ManagedWorktreeRow>(
      'SELECT * FROM managed_worktrees WHERE ownership_key = ?',
      [ownershipKey],
    );
    if (existing !== undefined) {
      if (existing.status === 'cleanup-required') {
        throw new WorkspaceRegistryError(
          'WORKTREE_CLEANUP_REQUIRED',
          existing.worktree_path,
          `managed worktree requires explicit cleanup or recovery: ${existing.worktree_path}`,
        );
      }
      const workspace = this.#read(parseEntityId('workspace', existing.workspace_id));
      if (workspace !== undefined) {
        const status = await inspectPersistedWorkspacePath(
          workspace.canonicalPath,
          this.#readFilesystemIdentity(workspace.workspaceId),
        );
        if (status === 'available') {
          const timestamp = this.#now().toISOString();
          this.#database.run(
            `
              UPDATE workspace_registry
              SET requested_path = ?,
                  last_used_at = ?,
                  owner_instance = ?,
                  status = 'available',
                  metadata_version = metadata_version + 1
              WHERE workspace_id = ?
            `,
            [absoluteRequestedPath, timestamp, this.#ownerInstance, workspace.workspaceId],
          );
          return this.#readRequired(workspace.workspaceId);
        }
      }

      this.#database.transaction(() => {
        const update = this.#database.run(
          `
            UPDATE managed_worktrees
            SET status = 'cleanup-required',
                updated_at = ?
            WHERE ownership_key = ? AND status = 'active'
          `,
          [this.#now().toISOString(), ownershipKey],
        );
        if (update.changes === 1) {
          this.#appendWorktreeJournal(
            ownershipKey,
            parseEntityId('workspace', existing.workspace_id),
            'cleanup-intent',
            { reason: 'managed-worktree-path-unavailable' },
          );
        }
      });
      throw new WorkspaceRegistryError(
        'WORKTREE_CLEANUP_REQUIRED',
        existing.worktree_path,
        `managed worktree requires explicit cleanup or recovery: ${existing.worktree_path}`,
      );
    }

    await mkdir(managedRoot, { recursive: true });
    const worktreePath = join(managedRoot, ownershipKey);
    const branch = `benchhand/${ownershipKey}`;
    const registration: ManagedWorktreeRegistration = {
      ownershipKey,
      absoluteRequestedPath,
      repoRoot,
      sourceFilesystemIdentity,
      requestedBaseRef,
      baseCommit,
      branch,
      worktreePath,
    };

    try {
      await lstat(worktreePath);
      const reconciled = await this.#tryReconcilePartialWorktree(registration);
      if (reconciled !== undefined) return reconciled;
      throw new WorkspaceRegistryError(
        'WORKTREE_PATH_OCCUPIED',
        worktreePath,
        `managed worktree path is already occupied without matching ownership: ${worktreePath}`,
      );
    } catch (error) {
      if (error instanceof WorkspaceRegistryError) throw error;
      if (!hasErrnoCode(error, 'ENOENT')) {
        throw classifyOpenPathError(worktreePath, error);
      }
    }

    let existingBranchCommit: string | null;
    try {
      existingBranchCommit = await readLocalBranchCommit(repoRoot, branch);
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        throw new WorkspaceRegistryError(error.code, repoRoot, error.message);
      }
      throw error;
    }
    if (existingBranchCommit !== null) {
      if (this.#hasWorktreeJournalAction(ownershipKey, 'create-intent')) {
        if (!this.#hasWorktreeJournalAction(ownershipKey, 'cleanup-intent')) {
          this.#appendWorktreeJournal(ownershipKey, null, 'cleanup-intent', {
            reason: 'orphaned-managed-branch',
            branch,
            branchCommit: existingBranchCommit,
          });
        }
        throw new WorkspaceRegistryError(
          'WORKTREE_CLEANUP_REQUIRED',
          repoRoot,
          `managed worktree branch requires explicit cleanup or recovery: ${branch}`,
        );
      }
      throw new WorkspaceRegistryError(
        'WORKTREE_BRANCH_OCCUPIED',
        repoRoot,
        `managed worktree branch is already occupied without durable ownership: ${branch}`,
      );
    }

    this.#appendWorktreeJournal(ownershipKey, null, 'create-intent', {
      repoRoot,
      requestedBaseRef,
      baseCommit,
      branch,
      worktreePath,
    });

    try {
      await createLockedWorktree({
        repoRoot,
        worktreePath,
        branch,
        baseCommit,
        ownershipKey,
      });
    } catch (error) {
      const reconciled = await this.#tryReconcilePartialWorktree(registration);
      if (reconciled !== undefined) return reconciled;
      this.#appendWorktreeJournal(ownershipKey, null, 'create-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof GitWorktreeError) {
        throw new WorkspaceRegistryError(error.code, worktreePath, error.message);
      }
      throw error;
    }

    return this.#registerManagedWorktree(registration, 'created');
  }

  async #tryReconcilePartialWorktree(
    registration: ManagedWorktreeRegistration,
  ): Promise<WorkspaceRecord | undefined> {
    const intent = this.#database.get<{ event_id: number }>(
      `
        SELECT event_id
        FROM worktree_cleanup_journal
        WHERE ownership_key = ? AND action = 'create-intent'
        ORDER BY event_id DESC
        LIMIT 1
      `,
      [registration.ownershipKey],
    );
    if (intent === undefined) return undefined;

    let canonicalExpectedPath: string;
    try {
      canonicalExpectedPath = await realpath(registration.worktreePath);
    } catch {
      return undefined;
    }

    let worktrees: GitWorktreeInfo[];
    try {
      worktrees = await listGitWorktrees(registration.repoRoot);
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        throw new WorkspaceRegistryError(error.code, registration.repoRoot, error.message);
      }
      throw error;
    }

    for (const worktree of worktrees) {
      let canonicalGitPath: string;
      try {
        canonicalGitPath = await realpath(worktree.path);
      } catch {
        continue;
      }
      if (canonicalGitPath !== canonicalExpectedPath) continue;
      if (worktree.head?.toLowerCase() !== registration.baseCommit) continue;
      if (worktree.branch !== `refs/heads/${registration.branch}`) continue;
      if (worktree.lockedReason !== `benchhand:${registration.ownershipKey}`) continue;

      return this.#registerManagedWorktree(registration, 'reconciled');
    }

    return undefined;
  }

  async #registerManagedWorktree(
    registration: ManagedWorktreeRegistration,
    journalAction: 'created' | 'reconciled',
  ): Promise<WorkspaceRecord> {
    const { canonicalPath, filesystemIdentity } = await resolveWorkspaceDirectory(
      registration.worktreePath,
    );
    const timestamp = this.#now().toISOString();
    const candidateWorkspaceId = this.#createWorkspaceId();
    const workspaceId = this.#database.transaction(() => {
      const existing = this.#database.get<ManagedWorktreeRow>(
        'SELECT * FROM managed_worktrees WHERE ownership_key = ? AND status = ?',
        [registration.ownershipKey, 'active'],
      );
      if (existing !== undefined) {
        return parseEntityId('workspace', existing.workspace_id);
      }

      this.#database.run(
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
          ) VALUES (?, ?, ?, ?, 'worktree', ?, ?, ?, ?, ?, ?, ?, 'available', 1)
        `,
        [
          candidateWorkspaceId,
          canonicalPath,
          registration.absoluteRequestedPath,
          filesystemIdentity,
          registration.repoRoot,
          canonicalPath,
          registration.baseCommit,
          registration.branch,
          timestamp,
          timestamp,
          this.#ownerInstance,
        ],
      );
      this.#database.run(
        `
          INSERT INTO managed_worktrees(
            ownership_key,
            workspace_id,
            source_repo_root,
            source_filesystem_identity,
            requested_base_ref,
            base_commit,
            branch,
            worktree_path,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `,
        [
          registration.ownershipKey,
          candidateWorkspaceId,
          registration.repoRoot,
          registration.sourceFilesystemIdentity,
          registration.requestedBaseRef,
          registration.baseCommit,
          registration.branch,
          canonicalPath,
          timestamp,
          timestamp,
        ],
      );
      this.#appendWorktreeJournal(registration.ownershipKey, candidateWorkspaceId, journalAction, {
        canonicalPath,
      });
      return candidateWorkspaceId;
    });

    return this.#readRequired(workspaceId);
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

  #readRequired(workspaceId: WorkspaceId): WorkspaceRecord {
    const workspace = this.#read(workspaceId);
    if (workspace === undefined) {
      throw new Error(`workspace ${workspaceId} disappeared from registry`);
    }
    return workspace;
  }

  #readFilesystemIdentity(workspaceId: WorkspaceId): string {
    const row = this.#database.get<{ filesystem_identity: string }>(
      'SELECT filesystem_identity FROM workspace_registry WHERE workspace_id = ?',
      [workspaceId],
    );
    if (row === undefined) {
      throw new Error(`workspace ${workspaceId} disappeared from registry`);
    }
    return row.filesystem_identity;
  }

  #appendWorktreeJournal(
    ownershipKey: string,
    workspaceId: WorkspaceId | null,
    action:
      | 'create-intent'
      | 'created'
      | 'create-failed'
      | 'cleanup-intent'
      | 'cleaned'
      | 'cleanup-failed'
      | 'reconciled',
    details: Record<string, string>,
  ): void {
    this.#database.run(
      `
        INSERT INTO worktree_cleanup_journal(
          ownership_key,
          workspace_id,
          action,
          details_json
        ) VALUES (?, ?, ?, ?)
      `,
      [ownershipKey, workspaceId, action, JSON.stringify(details)],
    );
  }

  #hasWorktreeJournalAction(
    ownershipKey: string,
    action:
      | 'create-intent'
      | 'created'
      | 'create-failed'
      | 'cleanup-intent'
      | 'cleaned'
      | 'cleanup-failed'
      | 'reconciled',
  ): boolean {
    return (
      this.#database.get<{ event_id: number }>(
        `
          SELECT event_id
          FROM worktree_cleanup_journal
          WHERE ownership_key = ? AND action = ?
          ORDER BY event_id DESC
          LIMIT 1
        `,
        [ownershipKey, action],
      ) !== undefined
    );
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

async function canonicalizePotentialPath(path: string): Promise<string> {
  let cursor = resolve(path);
  const suffix: string[] = [];

  for (;;) {
    try {
      const canonicalExisting = await realpath(cursor);
      return suffix.length === 0 ? canonicalExisting : join(canonicalExisting, ...suffix);
    } catch (error) {
      if (!hasErrnoCode(error, 'ENOENT')) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isSameOrDescendantPath(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === '' ||
    (pathFromParent !== '..' &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function worktreeOwnershipKey(sourceFilesystemIdentity: string, baseCommit: string): string {
  return createHash('sha256')
    .update(sourceFilesystemIdentity)
    .update('\0')
    .update(baseCommit)
    .digest('hex')
    .slice(0, 20);
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
