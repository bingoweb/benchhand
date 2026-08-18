import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, unlink } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';

import {
  type JsonValue,
  parseEntityId,
  parseResultEnvelope,
  parseRpcRequest,
  RPC_SCHEMA_VERSION,
  type RpcError,
  type RpcRequest,
} from '@benchhand/contracts';
import { FilesystemError, FilesystemService } from '@benchhand/filesystem';
import { InstructionsError, InstructionsService } from '@benchhand/instructions';
import { OperationJournal } from '@benchhand/operations';
import { openSqliteDatabase, type SqliteDatabase } from '@benchhand/storage';
import { WorkspaceRegistry, WorkspaceRegistryError } from '@benchhand/workspace';

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface StartDaemonOptions {
  databasePath: string;
  socketPath: string;
  worktreeRoot?: string;
}

export interface DaemonHandle {
  readonly instanceId: string;
  readonly socketPath: string;
  close(): Promise<void>;
}

export class DaemonStartError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DaemonStartError';
    this.code = code;
  }
}

export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
  if (options.databasePath.length === 0) {
    throw new TypeError('databasePath must not be empty');
  }
  if (options.socketPath.length === 0) {
    throw new TypeError('socketPath must not be empty');
  }
  if (options.worktreeRoot !== undefined && options.worktreeRoot.length === 0) {
    throw new TypeError('worktreeRoot must not be empty');
  }

  await prepareIpcEndpoint(options.socketPath);

  const database = openSqliteDatabase(options.databasePath);
  let server: http.Server | undefined;

  try {
    const instanceId = `daemon_${randomUUID()}`;
    const journal = new OperationJournal(database);
    journal.reconcileInterrupted();
    const workspaces = new WorkspaceRegistry(database, {
      ownerInstance: instanceId,
      worktreeRoot:
        options.worktreeRoot ?? join(dirname(resolve(options.databasePath)), 'worktrees'),
    });
    const filesystem = new FilesystemService({
      resolveWorkspace: (workspaceId) => workspaces.get(workspaceId),
    });
    const instructions = new InstructionsService({
      resolveWorkspace: (workspaceId) => workspaces.get(workspaceId),
    });
    const storageIntegrity = database.integrityCheck();
    if (storageIntegrity !== 'ok') {
      throw new Error(`SQLite integrity check failed: ${storageIntegrity}`);
    }

    let ready = false;
    server = http.createServer((request, response) => {
      void handleHttpRequest(
        request,
        response,
        createDispatchContext(
          database,
          journal,
          workspaces,
          filesystem,
          instructions,
          instanceId,
          () => ready,
        ),
      );
    });
    server.maxHeadersCount = 32;
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;

    await listenOnIpc(server, options.socketPath);
    ready = true;
    const listeningServer = server;

    let closed = false;
    return {
      instanceId,
      socketPath: options.socketPath,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        ready = false;
        await closeHttpServer(listeningServer);
        database.close();
      },
    };
  } catch (error) {
    if (server?.listening === true) {
      await closeHttpServer(server);
    }
    database.close();
    throw error;
  }
}

async function prepareIpcEndpoint(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return;

  const maximumBytes = unixSocketPathMaximumBytes();
  const pathBytes = Buffer.byteLength(socketPath, 'utf8');
  if (pathBytes > maximumBytes) {
    throw new DaemonStartError(
      'IPC_PATH_TOO_LONG',
      `IPC path is ${pathBytes} bytes; maximum supported length is ${maximumBytes} bytes`,
    );
  }

  let stats: Stats;
  try {
    stats = await lstat(socketPath);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return;
    throw error;
  }

  if (!stats.isSocket()) {
    throw new DaemonStartError(
      'IPC_PATH_OCCUPIED',
      `IPC path ${socketPath} exists and is not a Unix socket`,
    );
  }

  if (await isUnixSocketActive(socketPath)) {
    throw new DaemonStartError(
      'IPC_ENDPOINT_IN_USE',
      `IPC endpoint ${socketPath} is already owned by an active process`,
    );
  }

  try {
    await unlink(socketPath);
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) throw error;
  }
}

function unixSocketPathMaximumBytes(): number {
  if (process.platform === 'darwin') return 103;
  if (process.platform === 'linux') return 107;
  return 100;
}

function isUnixSocketActive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(500, () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        new DaemonStartError(
          'IPC_PROBE_TIMEOUT',
          `Timed out while checking existing IPC endpoint ${socketPath}`,
        ),
      );
    });
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        finish(false);
        return;
      }
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    });
  });
}

function isErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

interface DispatchContext {
  database: SqliteDatabase;
  journal: OperationJournal;
  workspaces: WorkspaceRegistry;
  filesystem: FilesystemService;
  instructions: InstructionsService;
  instanceId: string;
  isReady: () => boolean;
}

function createDispatchContext(
  database: SqliteDatabase,
  journal: OperationJournal,
  workspaces: WorkspaceRegistry,
  filesystem: FilesystemService,
  instructions: InstructionsService,
  instanceId: string,
  isReady: () => boolean,
): DispatchContext {
  return { database, journal, workspaces, filesystem, instructions, instanceId, isReady };
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DispatchContext,
): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/rpc') {
    writeRpcError(response, 'unparsed', {
      code: 'METHOD_NOT_FOUND',
      message: 'Only POST /rpc is supported',
      retryable: false,
    });
    return;
  }

  let requestId = 'unparsed';
  try {
    const body = await readRequestBody(request);
    const decoded = JSON.parse(body) as unknown;
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      'requestId' in decoded &&
      typeof decoded.requestId === 'string' &&
      decoded.requestId.length > 0
    ) {
      requestId = decoded.requestId;
    }

    const requestedSchemaVersion = readRequestedSchemaVersion(decoded);
    if (requestedSchemaVersion !== undefined && requestedSchemaVersion !== RPC_SCHEMA_VERSION) {
      writeRpcError(response, requestId, {
        code: 'UNSUPPORTED_SCHEMA_VERSION',
        message: `RPC schema version ${requestedSchemaVersion} is not supported`,
        retryable: false,
        details: {
          requested: requestedSchemaVersion,
          supported: [RPC_SCHEMA_VERSION],
        },
      });
      return;
    }

    const rpcRequest = parseRpcRequest(decoded);
    requestId = rpcRequest.requestId;

    if (rpcRequest.deadlineUnixMs !== undefined && rpcRequest.deadlineUnixMs <= Date.now()) {
      writeRpcError(response, requestId, {
        code: 'TIMEOUT',
        message: 'RPC deadline exceeded before dispatch',
        retryable: true,
      });
      return;
    }

    const result = await dispatchRpc(rpcRequest, context);
    writeRpcSuccess(response, requestId, result);
  } catch (error) {
    if (error instanceof DispatchError) {
      writeRpcError(response, requestId, error.rpcError);
      return;
    }

    writeRpcError(response, requestId, {
      code: 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : 'Invalid RPC request',
      retryable: false,
    });
  }
}

function readRequestedSchemaVersion(value: unknown): number | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    typeof value.schemaVersion !== 'number' ||
    !Number.isInteger(value.schemaVersion)
  ) {
    return undefined;
  }
  return value.schemaVersion;
}

async function dispatchRpc(request: RpcRequest, context: DispatchContext): Promise<JsonValue> {
  switch (request.method) {
    case 'system.health':
      return {
        live: true,
        ready: context.isReady(),
        state: context.isReady() ? 'healthy' : 'starting',
        instanceId: context.instanceId,
        rpcSchemaVersion: RPC_SCHEMA_VERSION,
        storageIntegrity: context.database.integrityCheck(),
      };
    case 'operation.get': {
      const operationId = readOperationIdParam(request.params);
      const record = context.journal.get(operationId);
      if (record === undefined) {
        throw new DispatchError({
          code: 'NOT_FOUND',
          message: `operation ${operationId} was not found`,
          retryable: false,
        });
      }
      return parseResultEnvelope({ ok: true, result: record }).result as JsonValue;
    }
    case 'workspace.open': {
      const open = readWorkspaceOpenParams(request.params);
      try {
        const workspace = await context.workspaces.open(open.path, {
          mode: open.mode,
          ...(open.baseRef === undefined ? {} : { baseRef: open.baseRef }),
        });
        return parseResultEnvelope({ ok: true, result: workspace }).result as JsonValue;
      } catch (error) {
        if (error instanceof WorkspaceRegistryError) {
          throw new DispatchError({
            code: error.code,
            message: error.message,
            retryable: error.code === 'WORKSPACE_PATH_INACCESSIBLE',
            details: { path: error.path },
          });
        }
        throw error;
      }
    }
    case 'workspace.get': {
      const workspaceId = readWorkspaceIdParam(request.params);
      const workspace = await context.workspaces.get(workspaceId);
      if (workspace === undefined) {
        throw new DispatchError({
          code: 'NOT_FOUND',
          message: `workspace ${workspaceId} was not found`,
          retryable: false,
        });
      }
      return parseResultEnvelope({ ok: true, result: workspace }).result as JsonValue;
    }
    case 'file.read':
      return dispatchFilesystem(() => context.filesystem.read(readFileReadParams(request.params)));
    case 'file.list':
      return dispatchFilesystem(() => context.filesystem.list(readFileListParams(request.params)));
    case 'file.search':
      return dispatchFilesystem(() =>
        context.filesystem.search(readFileSearchParams(request.params)),
      );
    case 'file.write':
      return dispatchFilesystem(() =>
        context.filesystem.write(readFileWriteParams(request.params)),
      );
    case 'file.patch':
      return dispatchFilesystem(() =>
        context.filesystem.patch(readFilePatchParams(request.params)),
      );
    case 'instructions.resolve':
      return dispatchInstructions(() =>
        context.instructions.resolve(readInstructionsResolveParams(request.params)),
      );
    case 'skills.list':
      return dispatchInstructions(() =>
        context.instructions.listSkills(readSkillsListParams(request.params)),
      );
    case 'skills.read':
      return dispatchInstructions(() =>
        context.instructions.readSkill(readSkillsReadParams(request.params)),
      );
    default:
      throw new DispatchError({
        code: 'METHOD_NOT_FOUND',
        message: `RPC method ${request.method} is not supported`,
        retryable: false,
      });
  }
}

async function dispatchInstructions(operation: () => Promise<unknown>): Promise<JsonValue> {
  try {
    return (await operation()) as JsonValue;
  } catch (error) {
    if (error instanceof InstructionsError) {
      throw new DispatchError({
        code: error.code,
        message: error.message,
        retryable:
          error.code === 'SCOPE_INACCESSIBLE' ||
          error.code === 'INSTRUCTION_INACCESSIBLE' ||
          error.code === 'INSTRUCTION_CHANGED_DURING_READ' ||
          error.code === 'SKILL_INACCESSIBLE',
        ...(error.path === null ? {} : { details: { path: error.path } }),
      });
    }
    throw error;
  }
}

async function dispatchFilesystem(operation: () => Promise<unknown>): Promise<JsonValue> {
  try {
    return (await operation()) as JsonValue;
  } catch (error) {
    if (error instanceof FilesystemError) {
      const details = mergeFilesystemErrorDetails(error);
      throw new DispatchError({
        code: error.code,
        message: error.message,
        retryable: error.code === 'PATH_INACCESSIBLE',
        ...(details === undefined ? {} : { details }),
      });
    }
    throw error;
  }
}

function readFileReadParams(params: unknown) {
  const value = readParamsObject(params, 'file.read');
  const workspaceId = readWorkspaceIdValue(value.workspaceId, 'file.read');
  const path = readRequiredString(value.path, 'file.read params.path');
  return {
    workspaceId,
    path,
    ...optionalNumber(value, 'offset'),
    ...optionalNumber(value, 'maxBytes'),
  };
}

function readFileListParams(params: unknown) {
  const value = readParamsObject(params, 'file.list');
  const workspaceId = readWorkspaceIdValue(value.workspaceId, 'file.list');
  return {
    workspaceId,
    ...optionalString(value, 'path'),
    ...optionalNumber(value, 'limit'),
    ...optionalString(value, 'cursor'),
  };
}

function readFileSearchParams(params: unknown) {
  const value = readParamsObject(params, 'file.search');
  const workspaceId = readWorkspaceIdValue(value.workspaceId, 'file.search');
  return {
    workspaceId,
    ...optionalString(value, 'path'),
    ...optionalString(value, 'glob'),
    ...optionalString(value, 'query'),
    ...optionalNumber(value, 'maxResults'),
    ...optionalNumber(value, 'maxBytes'),
    ...optionalNumber(value, 'maxDepth'),
    ...optionalNumber(value, 'maxFileBytes'),
  };
}

function readFileWriteParams(params: unknown) {
  const value = readParamsObject(params, 'file.write');
  const workspaceId = readWorkspaceIdValue(value.workspaceId, 'file.write');
  const path = readRequiredString(value.path, 'file.write params.path');
  const content = readRequiredString(value.content, 'file.write params.content');
  let expectedSha256: string | null | undefined;
  if ('expectedSha256' in value) {
    if (value.expectedSha256 !== null && typeof value.expectedSha256 !== 'string') {
      throw new DispatchError({
        code: 'INVALID_REQUEST',
        message: 'file.write params.expectedSha256 must be a string or null',
        retryable: false,
      });
    }
    expectedSha256 = value.expectedSha256;
  }
  return expectedSha256 === undefined
    ? { workspaceId, path, content }
    : { workspaceId, path, content, expectedSha256 };
}

function readFilePatchParams(params: unknown) {
  const value = readParamsObject(params, 'file.patch');
  const workspaceId = readWorkspaceIdValue(value.workspaceId, 'file.patch');
  const path = readRequiredString(value.path, 'file.patch params.path');
  const expectedSha256 = readRequiredString(
    value.expectedSha256,
    'file.patch params.expectedSha256',
  );
  if (!Array.isArray(value.edits)) {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: 'file.patch params.edits must be an array',
      retryable: false,
    });
  }
  const edits = value.edits.map((edit, index) => {
    if (
      typeof edit !== 'object' ||
      edit === null ||
      Array.isArray(edit) ||
      !('oldText' in edit) ||
      typeof edit.oldText !== 'string' ||
      !('newText' in edit) ||
      typeof edit.newText !== 'string'
    ) {
      throw new DispatchError({
        code: 'INVALID_REQUEST',
        message: `file.patch params.edits[${index}] must contain string oldText and newText`,
        retryable: false,
      });
    }
    return { oldText: edit.oldText, newText: edit.newText };
  });
  return { workspaceId, path, expectedSha256, edits };
}

function readInstructionsResolveParams(params: unknown) {
  const value = readParamsObject(params, 'instructions.resolve');
  const workspaceId = readWorkspaceIdValue(value.workspaceId, 'instructions.resolve');
  if (!('scopePath' in value) || value.scopePath === undefined) {
    return { workspaceId };
  }
  if (typeof value.scopePath !== 'string') {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: 'instructions.resolve params.scopePath must be a string',
      retryable: false,
    });
  }
  return { workspaceId, scopePath: value.scopePath };
}

function readSkillsListParams(params: unknown) {
  const value = readParamsObject(params, 'skills.list');
  return {
    workspaceId: readWorkspaceIdValue(value.workspaceId, 'skills.list'),
  };
}

function readSkillsReadParams(params: unknown) {
  const value = readParamsObject(params, 'skills.read');
  const workspaceId = readWorkspaceIdValue(value.workspaceId, 'skills.read');
  if (typeof value.skillId !== 'string' || value.skillId.length === 0) {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: 'skills.read requires params.skillId',
      retryable: false,
    });
  }
  return { workspaceId, skillId: value.skillId };
}

function mergeFilesystemErrorDetails(error: FilesystemError): JsonValue | undefined {
  if (error.path === null) return error.details;
  if (
    typeof error.details === 'object' &&
    error.details !== null &&
    !Array.isArray(error.details)
  ) {
    return { path: error.path, ...error.details };
  }
  if (error.details !== undefined) {
    return { path: error.path, evidence: error.details };
  }
  return { path: error.path };
}

function readParamsObject(params: unknown, method: string): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: `${method} requires object params`,
      retryable: false,
    });
  }
  return params as Record<string, unknown>;
}

function readWorkspaceIdValue(value: unknown, method: string) {
  if (typeof value !== 'string') {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: `${method} requires params.workspaceId`,
      retryable: false,
    });
  }
  return parseEntityId('workspace', value);
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: `${label} must be a string`,
      retryable: false,
    });
  }
  return value;
}

function optionalString(value: Record<string, unknown>, key: string): Record<string, string> {
  if (!(key in value) || value[key] === undefined) return {};
  if (typeof value[key] !== 'string') {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: `${key} must be a string`,
      retryable: false,
    });
  }
  return { [key]: value[key] } as Record<string, string>;
}

function optionalNumber(value: Record<string, unknown>, key: string): Record<string, number> {
  if (!(key in value) || value[key] === undefined) return {};
  if (typeof value[key] !== 'number') {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: `${key} must be a number`,
      retryable: false,
    });
  }
  return { [key]: value[key] } as Record<string, number>;
}

function readWorkspaceOpenParams(params: unknown): {
  path: string;
  mode: 'checkout' | 'worktree';
  baseRef?: string;
} {
  if (
    typeof params !== 'object' ||
    params === null ||
    !('path' in params) ||
    typeof params.path !== 'string' ||
    params.path.length === 0
  ) {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: 'workspace.open requires params.path',
      retryable: false,
    });
  }

  let mode: 'checkout' | 'worktree' = 'checkout';
  if ('mode' in params && params.mode !== undefined) {
    if (params.mode !== 'checkout' && params.mode !== 'worktree') {
      throw new DispatchError({
        code: 'INVALID_REQUEST',
        message: 'workspace.open params.mode must be checkout or worktree',
        retryable: false,
      });
    }
    mode = params.mode;
  }

  let baseRef: string | undefined;
  if ('baseRef' in params && params.baseRef !== undefined) {
    if (typeof params.baseRef !== 'string' || params.baseRef.length === 0) {
      throw new DispatchError({
        code: 'INVALID_REQUEST',
        message: 'workspace.open params.baseRef must be a non-empty string',
        retryable: false,
      });
    }
    baseRef = params.baseRef;
  }

  if (mode !== 'worktree' && baseRef !== undefined) {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: 'workspace.open params.baseRef requires worktree mode',
      retryable: false,
    });
  }

  return baseRef === undefined ? { path: params.path, mode } : { path: params.path, mode, baseRef };
}

function readWorkspaceIdParam(params: unknown) {
  if (
    typeof params !== 'object' ||
    params === null ||
    !('workspaceId' in params) ||
    typeof params.workspaceId !== 'string'
  ) {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: 'workspace.get requires params.workspaceId',
      retryable: false,
    });
  }

  return parseEntityId('workspace', params.workspaceId);
}

function readOperationIdParam(params: unknown) {
  if (
    typeof params !== 'object' ||
    params === null ||
    !('operationId' in params) ||
    typeof params.operationId !== 'string'
  ) {
    throw new DispatchError({
      code: 'INVALID_REQUEST',
      message: 'operation.get requires params.operationId',
      retryable: false,
    });
  }

  return parseEntityId('operation', params.operationId);
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;

    request.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error('RPC request exceeds maximum size'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('aborted', () => reject(new Error('RPC request was aborted')));
    request.on('error', reject);
  });
}

function writeRpcSuccess(response: ServerResponse, requestId: string, result: JsonValue): void {
  writeJson(response, {
    schemaVersion: RPC_SCHEMA_VERSION,
    requestId,
    ok: true,
    result,
  });
}

function writeRpcError(response: ServerResponse, requestId: string, error: RpcError): void {
  writeJson(response, {
    schemaVersion: RPC_SCHEMA_VERSION,
    requestId,
    ok: false,
    error,
  });
}

function writeJson(response: ServerResponse, value: JsonValue): void {
  if (response.writableEnded || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function listenOnIpc(server: http.Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function closeHttpServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

class DispatchError extends Error {
  readonly rpcError: RpcError;

  constructor(error: RpcError) {
    super(error.message);
    this.name = 'DispatchError';
    this.rpcError = error;
  }
}
