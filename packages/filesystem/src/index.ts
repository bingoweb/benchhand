import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

import type { WorkspaceId, WorkspaceRecord } from '@udmcp/contracts';
import { minimatch } from 'minimatch';

const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const DEFAULT_SEARCH_RESULTS = 100;
const MAX_SEARCH_RESULTS = 1000;
const DEFAULT_SEARCH_OUTPUT_BYTES = 256 * 1024;
const MAX_SEARCH_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_SEARCH_DEPTH = 20;
const MAX_SEARCH_DEPTH = 100;
const DEFAULT_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_ENTRIES = 50_000;
const PREVIEW_CHARACTERS = 300;
const MAX_WRITE_BYTES = 16 * 1024 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;

export type FileClassification = 'text' | 'binary';
export type FileEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface FilesystemReadRequest {
  workspaceId: WorkspaceId;
  path: string;
  offset?: number;
  maxBytes?: number;
}

export interface FilesystemReadResult {
  path: string;
  classification: FileClassification;
  size: number;
  offset: number;
  bytesRead: number;
  eof: boolean;
  truncated: boolean;
  content: string | null;
}

export interface FilesystemListRequest {
  workspaceId: WorkspaceId;
  path?: string;
  limit?: number;
  cursor?: string;
}

export interface FilesystemListEntry {
  name: string;
  path: string;
  type: FileEntryType;
  size: number | null;
}

export interface FilesystemListResult {
  path: string;
  entries: FilesystemListEntry[];
  nextCursor: string | null;
}

export interface FilesystemSearchRequest {
  workspaceId: WorkspaceId;
  path?: string;
  glob?: string;
  query?: string;
  maxResults?: number;
  maxBytes?: number;
  maxDepth?: number;
  maxFileBytes?: number;
}

export interface FilesystemSearchMatch {
  path: string;
  line: number | null;
  column: number | null;
  preview: string | null;
}

export interface FilesystemSearchResult {
  path: string;
  glob: string;
  query: string | null;
  matches: FilesystemSearchMatch[];
  truncated: boolean;
  scannedFiles: number;
  skippedBinary: number;
  skippedOversized: number;
}

export interface FilesystemWriteRequest {
  workspaceId: WorkspaceId;
  path: string;
  content: string;
  expectedSha256?: string | null;
}

export interface FilesystemWriteResult {
  path: string;
  created: boolean;
  previousSha256: string | null;
  sha256: string;
  bytesWritten: number;
  durability: 'file-and-directory' | 'file-only';
}

export class FilesystemError extends Error {
  readonly code: string;
  readonly path: string | null;

  constructor(code: string, path: string | null, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FilesystemError';
    this.code = code;
    this.path = path;
  }
}

export interface FilesystemServiceOptions {
  resolveWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceRecord | undefined>;
  linkFile?(stagedPath: string, targetPath: string): Promise<void>;
  renameFile?(oldPath: string, newPath: string): Promise<void>;
  syncDirectory?(directory: string): Promise<boolean>;
}

interface WorkspaceAccess {
  root: string;
}

interface ListCursor {
  version: 1;
  path: string;
  after: string;
}

interface SearchState {
  matches: FilesystemSearchMatch[];
  truncated: boolean;
  outputBytes: number;
  scannedEntries: number;
  scannedFiles: number;
  skippedBinary: number;
  skippedOversized: number;
}

export class FilesystemService {
  readonly #resolveWorkspace: FilesystemServiceOptions['resolveWorkspace'];
  readonly #linkFile: NonNullable<FilesystemServiceOptions['linkFile']>;
  readonly #renameFile: NonNullable<FilesystemServiceOptions['renameFile']>;
  readonly #syncDirectory: NonNullable<FilesystemServiceOptions['syncDirectory']>;
  readonly #writeTails = new Map<string, Promise<void>>();

  constructor(options: FilesystemServiceOptions) {
    this.#resolveWorkspace = options.resolveWorkspace;
    this.#linkFile = options.linkFile ?? link;
    this.#renameFile = options.renameFile ?? rename;
    this.#syncDirectory = options.syncDirectory ?? syncDirectoryBestEffort;
  }

  async read(request: FilesystemReadRequest): Promise<FilesystemReadResult> {
    const access = await this.#accessWorkspace(request.workspaceId);
    const path = normalizeRelativePath(request.path, false);
    const offset = boundedInteger(request.offset ?? 0, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = boundedInteger(
      request.maxBytes ?? DEFAULT_READ_BYTES,
      'maxBytes',
      1,
      MAX_READ_BYTES,
    );
    const absolutePath = await resolveExistingPath(access.root, path);
    const handle = await open(absolutePath, 'r').catch((error) => {
      throw mapFilesystemError(path, error);
    });

    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new FilesystemError('PATH_NOT_FILE', path, `path is not a regular file: ${path}`);
      }
      if (!Number.isSafeInteger(stats.size)) {
        throw new FilesystemError(
          'FILE_TOO_LARGE',
          path,
          `file size exceeds safe integer range: ${path}`,
        );
      }

      const available = Math.max(0, stats.size - offset);
      const length = Math.min(maxBytes, available);
      const buffer = Buffer.alloc(length);
      const { bytesRead } =
        length === 0
          ? { bytesRead: 0 }
          : await handle.read({ buffer, offset: 0, length, position: offset });
      const data = buffer.subarray(0, bytesRead);
      const classification = classifyBuffer(data);
      const eof = offset + bytesRead >= stats.size;

      return {
        path,
        classification,
        size: stats.size,
        offset,
        bytesRead,
        eof,
        truncated: !eof,
        content: classification === 'text' ? decodeUtf8(data) : null,
      };
    } finally {
      await handle.close();
    }
  }

  async list(request: FilesystemListRequest): Promise<FilesystemListResult> {
    const access = await this.#accessWorkspace(request.workspaceId);
    const path = normalizeRelativePath(request.path ?? '.', true);
    const limit = boundedInteger(request.limit ?? DEFAULT_LIST_LIMIT, 'limit', 1, MAX_LIST_LIMIT);
    const cursor = request.cursor === undefined ? null : decodeListCursor(request.cursor, path);
    const absolutePath = await resolveExistingPath(access.root, path);
    const entries = await readdir(absolutePath, { withFileTypes: true }).catch((error) => {
      throw mapFilesystemError(path, error);
    });

    const listed: FilesystemListEntry[] = [];
    for (const dirent of entries) {
      const childAbsolute = join(absolutePath, dirent.name);
      const metadata = await readEntryMetadata(childAbsolute, dirent.isSymbolicLink());
      const type = direntType(dirent);
      listed.push({
        name: dirent.name,
        path: joinPortable(path, dirent.name),
        type,
        size: type === 'file' ? metadata.size : null,
      });
    }
    listed.sort((left, right) => compareCodePoints(left.name, right.name));

    const start =
      cursor === null
        ? 0
        : listed.findIndex((entry) => compareCodePoints(entry.name, cursor.after) > 0);
    const normalizedStart = start < 0 ? listed.length : start;
    const page = listed.slice(normalizedStart, normalizedStart + limit);
    const hasMore = normalizedStart + page.length < listed.length;
    const nextCursor =
      hasMore && page.length > 0
        ? encodeListCursor({ version: 1, path, after: page.at(-1)?.name ?? '' })
        : null;

    return { path, entries: page, nextCursor };
  }

  async search(request: FilesystemSearchRequest): Promise<FilesystemSearchResult> {
    const access = await this.#accessWorkspace(request.workspaceId);
    const path = normalizeRelativePath(request.path ?? '.', true);
    const glob = validateSearchString(request.glob ?? '**/*', 'glob', 1, 1024);
    const query =
      request.query === undefined ? null : validateSearchString(request.query, 'query', 1, 4096);
    const maxResults = boundedInteger(
      request.maxResults ?? DEFAULT_SEARCH_RESULTS,
      'maxResults',
      1,
      MAX_SEARCH_RESULTS,
    );
    const maxBytes = boundedInteger(
      request.maxBytes ?? DEFAULT_SEARCH_OUTPUT_BYTES,
      'maxBytes',
      1,
      MAX_SEARCH_OUTPUT_BYTES,
    );
    const maxDepth = boundedInteger(
      request.maxDepth ?? DEFAULT_SEARCH_DEPTH,
      'maxDepth',
      0,
      MAX_SEARCH_DEPTH,
    );
    const maxFileBytes = boundedInteger(
      request.maxFileBytes ?? DEFAULT_SEARCH_FILE_BYTES,
      'maxFileBytes',
      1,
      MAX_SEARCH_FILE_BYTES,
    );
    const absolutePath = await resolveExistingPath(access.root, path);
    const state: SearchState = {
      matches: [],
      truncated: false,
      outputBytes: 0,
      scannedEntries: 0,
      scannedFiles: 0,
      skippedBinary: 0,
      skippedOversized: 0,
    };

    await this.#walkSearch({
      workspaceRoot: access.root,
      directory: absolutePath,
      directoryPath: path,
      depth: 0,
      glob,
      query,
      maxDepth,
      maxFileBytes,
      maxResults,
      maxBytes,
      state,
    });

    return {
      path,
      glob,
      query,
      matches: state.matches,
      truncated: state.truncated,
      scannedFiles: state.scannedFiles,
      skippedBinary: state.skippedBinary,
      skippedOversized: state.skippedOversized,
    };
  }

  async write(request: FilesystemWriteRequest): Promise<FilesystemWriteResult> {
    if (typeof request.content !== 'string') {
      throw new FilesystemError('INVALID_REQUEST', request.path, 'content must be a string');
    }
    const content = Buffer.from(request.content, 'utf8');
    if (content.byteLength > MAX_WRITE_BYTES) {
      throw new FilesystemError(
        'WRITE_TOO_LARGE',
        request.path,
        `write content exceeds ${MAX_WRITE_BYTES} UTF-8 bytes`,
      );
    }
    const expectedSha256 = normalizeExpectedSha256(request.expectedSha256);
    const access = await this.#accessWorkspace(request.workspaceId);
    const path = normalizeRelativePath(request.path, false);
    const parentPath = posix.dirname(path);
    const canonicalParent = await resolveExistingPath(access.root, parentPath);
    const parentStats = await lstat(canonicalParent).catch((error) => {
      throw mapFilesystemError(parentPath, error);
    });
    if (!parentStats.isDirectory()) {
      throw new FilesystemError(
        'PATH_NOT_DIRECTORY',
        parentPath,
        `write parent is not a directory: ${parentPath}`,
      );
    }
    const target = join(canonicalParent, basename(path));
    if (!isSameOrDescendant(access.root, target)) {
      throw new FilesystemError(
        'PATH_OUTSIDE_WORKSPACE',
        path,
        `write target escapes workspace: ${path}`,
      );
    }

    return this.#serializeWrite(target, () =>
      this.#writeAtomic({
        path,
        target,
        parent: canonicalParent,
        content,
        expectedSha256,
      }),
    );
  }

  async #accessWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceAccess> {
    const workspace = await this.#resolveWorkspace(workspaceId);
    if (workspace === undefined) {
      throw new FilesystemError(
        'WORKSPACE_NOT_FOUND',
        null,
        `workspace ${workspaceId} was not found`,
      );
    }
    if (workspace.status !== 'available') {
      throw new FilesystemError(
        'WORKSPACE_UNAVAILABLE',
        null,
        `workspace ${workspaceId} is ${workspace.status}`,
      );
    }

    let root: string;
    try {
      root = await realpath(workspace.canonicalPath);
    } catch (error) {
      throw new FilesystemError(
        'WORKSPACE_UNAVAILABLE',
        null,
        `workspace ${workspaceId} root is unavailable`,
        { cause: error },
      );
    }
    if (!samePath(root, workspace.canonicalPath)) {
      throw new FilesystemError(
        'WORKSPACE_UNAVAILABLE',
        null,
        `workspace ${workspaceId} root identity changed`,
      );
    }
    return { root };
  }

  async #walkSearch(options: {
    workspaceRoot: string;
    directory: string;
    directoryPath: string;
    depth: number;
    glob: string;
    query: string | null;
    maxDepth: number;
    maxFileBytes: number;
    maxResults: number;
    maxBytes: number;
    state: SearchState;
  }): Promise<void> {
    if (options.state.scannedEntries >= MAX_SEARCH_ENTRIES) {
      options.state.truncated = true;
      return;
    }

    const entries = await readdir(options.directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      options.state.scannedEntries += 1;
      if (options.state.scannedEntries > MAX_SEARCH_ENTRIES) {
        options.state.truncated = true;
        return;
      }

      const relativePath = joinPortable(options.directoryPath, entry.name);
      const childPath = join(options.directory, entry.name);
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (options.depth >= options.maxDepth) continue;
        let canonicalDirectory: string;
        try {
          canonicalDirectory = await realpath(childPath);
        } catch {
          continue;
        }
        if (!isSameOrDescendant(options.workspaceRoot, canonicalDirectory)) continue;
        await this.#walkSearch({
          ...options,
          directory: canonicalDirectory,
          directoryPath: relativePath,
          depth: options.depth + 1,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!minimatch(relativePath, options.glob, { dot: true })) continue;

      options.state.scannedFiles += 1;
      if (options.query === null) {
        appendSearchMatch(
          options.state,
          { path: relativePath, line: null, column: null, preview: null },
          options.maxResults,
          options.maxBytes,
        );
        continue;
      }

      let canonicalFile: string;
      try {
        canonicalFile = await realpath(childPath);
      } catch {
        continue;
      }
      if (!isSameOrDescendant(options.workspaceRoot, canonicalFile)) continue;

      const handle = await open(canonicalFile, 'r').catch(() => null);
      if (handle === null) continue;
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) continue;
        if (stats.size > options.maxFileBytes || !Number.isSafeInteger(stats.size)) {
          options.state.skippedOversized += 1;
          continue;
        }
        const data = Buffer.alloc(stats.size);
        const { bytesRead } =
          stats.size === 0
            ? { bytesRead: 0 }
            : await handle.read({ buffer: data, offset: 0, length: stats.size, position: 0 });
        const bounded = data.subarray(0, bytesRead);
        if (classifyBuffer(bounded) === 'binary') {
          options.state.skippedBinary += 1;
          continue;
        }
        const lines = decodeUtf8(bounded).split('\n');
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex] ?? '';
          let from = 0;
          for (;;) {
            const found = line.indexOf(options.query, from);
            if (found < 0) break;
            appendSearchMatch(
              options.state,
              {
                path: relativePath,
                line: lineIndex + 1,
                column: found + 1,
                preview: boundedPreview(line),
              },
              options.maxResults,
              options.maxBytes,
            );
            from = found + Math.max(1, options.query.length);
          }
        }
      } finally {
        await handle.close();
      }
    }
  }

  async #writeAtomic(options: {
    path: string;
    target: string;
    parent: string;
    content: Buffer;
    expectedSha256: string | null | undefined;
  }): Promise<FilesystemWriteResult> {
    const initial = await inspectWriteTarget(options.target, options.path);
    enforceWritePrecondition(options.expectedSha256, initial, options.path);

    const tempPath = join(
      options.parent,
      `.${basename(options.target)}.udmcp-write-${process.pid}-${randomUUID()}.tmp`,
    );
    let tempExists = false;
    let renamed = false;

    try {
      const mode = initial.exists ? initial.mode : 0o666;
      const handle = await open(tempPath, 'wx', mode).catch((error) => {
        throw mapWriteFailure(options.path, error);
      });
      tempExists = true;
      try {
        if (initial.exists) await handle.chmod(initial.mode);
        await handle.writeFile(options.content);
        await handle.sync();
      } finally {
        await handle.close();
      }

      const beforeCommit = await inspectWriteTarget(options.target, options.path);
      enforceWritePrecondition(options.expectedSha256, beforeCommit, options.path);

      if (options.expectedSha256 === null) {
        try {
          await this.#linkFile(tempPath, options.target);
        } catch (error) {
          if (hasErrnoCode(error, 'EEXIST')) {
            throw new FilesystemError(
              'WRITE_CONFLICT',
              options.path,
              `create-only precondition lost a commit race for ${options.path}`,
              { cause: error },
            );
          }
          throw mapWriteFailure(options.path, error);
        }
        await rm(tempPath, { force: true }).catch(() => {});
        tempExists = false;
      } else {
        await this.#renameFile(tempPath, options.target).catch((error) => {
          throw mapWriteFailure(options.path, error);
        });
        tempExists = false;
      }
      renamed = true;

      let directorySynced = false;
      try {
        directorySynced = await this.#syncDirectory(options.parent);
      } catch {
        directorySynced = false;
      }
      const durability = directorySynced ? 'file-and-directory' : 'file-only';
      return {
        path: options.path,
        created: !beforeCommit.exists,
        previousSha256: beforeCommit.exists ? beforeCommit.sha256 : null,
        sha256: createHash('sha256').update(options.content).digest('hex'),
        bytesWritten: options.content.byteLength,
        durability,
      };
    } finally {
      if (tempExists && !renamed) {
        await rm(tempPath, { force: true }).catch(() => {});
      }
    }
  }

  async #serializeWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#writeTails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#writeTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#writeTails.get(key) === tail) this.#writeTails.delete(key);
    }
  }
}

interface WriteTargetState {
  exists: boolean;
  mode: number;
  sha256: string | null;
}

async function inspectWriteTarget(target: string, portablePath: string): Promise<WriteTargetState> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return { exists: false, mode: 0, sha256: null };
    throw mapFilesystemError(portablePath, error);
  }
  if (stats.isSymbolicLink()) {
    throw new FilesystemError(
      'PATH_SYMLINK_UNSUPPORTED',
      portablePath,
      `atomic write does not replace symlink targets: ${portablePath}`,
    );
  }
  if (!stats.isFile()) {
    throw new FilesystemError(
      'PATH_NOT_FILE',
      portablePath,
      `atomic write target is not a regular file: ${portablePath}`,
    );
  }
  return {
    exists: true,
    mode: stats.mode & 0o7777,
    sha256: await sha256File(target, portablePath),
  };
}

async function sha256File(target: string, portablePath: string): Promise<string> {
  const handle = await open(target, 'r').catch((error) => {
    throw mapFilesystemError(portablePath, error);
  });
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
  try {
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read({
        buffer,
        offset: 0,
        length: buffer.length,
        position,
      });
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function normalizeExpectedSha256(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new FilesystemError(
      'INVALID_REQUEST',
      null,
      'expectedSha256 must be null or a 64-character hexadecimal SHA-256 digest',
    );
  }
  return value.toLowerCase();
}

function enforceWritePrecondition(
  expected: string | null | undefined,
  current: WriteTargetState,
  path: string,
): void {
  if (expected === undefined) return;
  if (expected === null) {
    if (current.exists) {
      throw new FilesystemError(
        'WRITE_CONFLICT',
        path,
        `create-only precondition failed because target already exists: ${path}`,
      );
    }
    return;
  }
  if (!current.exists || current.sha256 !== expected) {
    throw new FilesystemError('WRITE_CONFLICT', path, `SHA-256 precondition failed for ${path}`);
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function mapWriteFailure(path: string, error: unknown): FilesystemError {
  if (error instanceof FilesystemError) return error;
  if (hasErrnoCode(error, 'EACCES') || hasErrnoCode(error, 'EPERM')) {
    return new FilesystemError('PATH_INACCESSIBLE', path, `write target is inaccessible: ${path}`, {
      cause: error,
    });
  }
  return new FilesystemError(
    'WRITE_FAILED',
    path,
    error instanceof Error ? error.message : `atomic write failed for ${path}`,
    { cause: error },
  );
}

function normalizeRelativePath(input: string, allowRoot: boolean): string {
  if (typeof input !== 'string' || input.includes('\0')) {
    throw new FilesystemError('INVALID_PATH', null, 'path must be a NUL-free string');
  }
  if (posix.isAbsolute(input) || win32.isAbsolute(input) || isAbsolute(input)) {
    throw new FilesystemError('PATH_OUTSIDE_WORKSPACE', input, 'absolute paths are not allowed');
  }
  const portable = input.replaceAll('\\', '/');
  const segments = portable.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new FilesystemError('PATH_OUTSIDE_WORKSPACE', input, 'path traversal is not allowed');
  }
  if (segments.length === 0) {
    if (!allowRoot) throw new FilesystemError('INVALID_PATH', input, 'file path must not be empty');
    return '.';
  }
  return segments.join('/');
}

async function resolveExistingPath(root: string, portablePath: string): Promise<string> {
  const candidate =
    portablePath === '.' ? root : resolve(root, ...portablePath.split('/').filter(Boolean));
  if (!isSameOrDescendant(root, candidate)) {
    throw new FilesystemError(
      'PATH_OUTSIDE_WORKSPACE',
      portablePath,
      `path escapes workspace: ${portablePath}`,
    );
  }

  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    throw mapFilesystemError(portablePath, error);
  }
  if (!isSameOrDescendant(root, canonical)) {
    throw new FilesystemError(
      'PATH_OUTSIDE_WORKSPACE',
      portablePath,
      `path resolves outside workspace: ${portablePath}`,
    );
  }
  return canonical;
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new FilesystemError(
      'INVALID_REQUEST',
      null,
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function validateSearchString(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new FilesystemError(
      'INVALID_REQUEST',
      null,
      `${name} length must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function classifyBuffer(buffer: Buffer): FileClassification {
  if (buffer.includes(0)) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return 'text';
  } catch {
    return 'binary';
  }
}

function decodeUtf8(buffer: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function direntType(dirent: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FileEntryType {
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

async function readEntryMetadata(path: string, symlink: boolean): Promise<{ size: number }> {
  if (symlink) return { size: 0 };
  const stats = await lstat(path);
  return { size: Number.isSafeInteger(stats.size) ? stats.size : 0 };
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function joinPortable(base: string, name: string): string {
  return base === '.' ? name : `${base}/${name}`;
}

function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeListCursor(encoded: string, path: string): ListCursor {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('path' in parsed) ||
      parsed.path !== path ||
      !('after' in parsed) ||
      typeof parsed.after !== 'string' ||
      parsed.after.length === 0
    ) {
      throw new Error('invalid cursor shape');
    }
    return parsed as ListCursor;
  } catch (error) {
    throw new FilesystemError('INVALID_CURSOR', path, 'directory cursor is invalid', {
      cause: error,
    });
  }
}

function appendSearchMatch(
  state: SearchState,
  match: FilesystemSearchMatch,
  maxResults: number,
  maxBytes: number,
): void {
  const estimatedBytes =
    Buffer.byteLength(match.path, 'utf8') +
    (match.preview === null ? 0 : Buffer.byteLength(match.preview, 'utf8')) +
    64;
  if (state.matches.length >= maxResults || state.outputBytes + estimatedBytes > maxBytes) {
    state.truncated = true;
    return;
  }
  state.matches.push(match);
  state.outputBytes += estimatedBytes;
}

function boundedPreview(line: string): string {
  return line.length <= PREVIEW_CHARACTERS ? line : `${line.slice(0, PREVIEW_CHARACTERS)}…`;
}

function mapFilesystemError(path: string, error: unknown): FilesystemError {
  if (hasErrnoCode(error, 'ENOENT') || hasErrnoCode(error, 'ENOTDIR')) {
    return new FilesystemError('PATH_NOT_FOUND', path, `path was not found: ${path}`, {
      cause: error,
    });
  }
  if (hasErrnoCode(error, 'EACCES') || hasErrnoCode(error, 'EPERM')) {
    return new FilesystemError('PATH_INACCESSIBLE', path, `path is inaccessible: ${path}`, {
      cause: error,
    });
  }
  return new FilesystemError(
    'FILESYSTEM_FAILURE',
    path,
    error instanceof Error ? error.message : `filesystem operation failed for ${path}`,
    { cause: error },
  );
}

function hasErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
