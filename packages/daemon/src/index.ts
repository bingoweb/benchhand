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
} from '@udmcp/contracts';
import { OperationJournal } from '@udmcp/operations';
import { openSqliteDatabase, type SqliteDatabase } from '@udmcp/storage';
import { WorkspaceRegistry, WorkspaceRegistryError } from '@udmcp/workspace';

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
    const storageIntegrity = database.integrityCheck();
    if (storageIntegrity !== 'ok') {
      throw new Error(`SQLite integrity check failed: ${storageIntegrity}`);
    }

    let ready = false;
    server = http.createServer((request, response) => {
      void handleHttpRequest(
        request,
        response,
        createDispatchContext(database, journal, workspaces, instanceId, () => ready),
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
  instanceId: string;
  isReady: () => boolean;
}

function createDispatchContext(
  database: SqliteDatabase,
  journal: OperationJournal,
  workspaces: WorkspaceRegistry,
  instanceId: string,
  isReady: () => boolean,
): DispatchContext {
  return { database, journal, workspaces, instanceId, isReady };
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
    default:
      throw new DispatchError({
        code: 'METHOD_NOT_FOUND',
        message: `RPC method ${request.method} is not supported`,
        retryable: false,
      });
  }
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
