import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type JsonValue, parseWorkspaceRecord } from '@benchhand/contracts';
import { createLocalRpcClient, RpcCallError } from '@benchhand/local-rpc';
import {
  localhostHostValidation,
  localhostOriginValidation,
  type NodeIncomingMessageLike,
  type NodeServerResponseLike,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const EDGE_VERSION = '0.0.0-dev';
const MODERN_PROTOCOL_VERSION = '2026-07-28';

const daemonHealthSchema = z.object({
  live: z.literal(true),
  ready: z.literal(true),
  state: z.literal('healthy'),
  rpcSchemaVersion: z.number().int().nonnegative(),
  storageIntegrity: z.string(),
});

const healthToolOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('healthy'),
    live: z.literal(true),
    ready: z.literal(true),
    rpcSchemaVersion: z.number().int().nonnegative(),
    storageIntegrity: z.string(),
  }),
  z.object({
    status: z.literal('unavailable'),
    errorCode: z.string(),
    retryable: z.boolean(),
  }),
]);

const capabilitiesOutputSchema = z.object({
  protocolVersions: z.array(z.string()),
  protocolEras: z.array(z.enum(['legacy', 'modern'])),
  durableOperations: z.literal(true),
  localRpcSchemaVersion: z.literal(1),
});

const systemInfoOutputSchema = z.object({
  edgeVersion: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  architecture: z.string(),
});

const workspaceRecordOutputSchema = z.object({
  workspaceId: z.string().min(1),
  canonicalPath: z.string().min(1),
  requestedPath: z.string().min(1),
  mode: z.enum(['checkout', 'worktree']),
  repoRoot: z.string().min(1).nullable(),
  worktreePath: z.string().min(1).nullable(),
  baseRef: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  lastUsedAt: z.string().min(1),
  ownerInstance: z.string().min(1).nullable(),
  status: z.enum(['available', 'missing', 'inaccessible', 'invalid']),
  metadataVersion: z.number().int().min(1),
});

const workspaceToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    workspace: workspaceRecordOutputSchema,
  }),
  z.object({
    ok: z.literal(false),
    errorCode: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);

const fileReadResultSchema = z.object({
  path: z.string().min(1),
  classification: z.enum(['text', 'binary']),
  size: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  eof: z.boolean(),
  truncated: z.boolean(),
  content: z.string().nullable(),
});

const fileListResultSchema = z.object({
  path: z.string().min(1),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string().min(1),
      type: z.enum(['file', 'directory', 'symlink', 'other']),
      size: z.number().int().nonnegative().nullable(),
    }),
  ),
  nextCursor: z.string().min(1).nullable(),
});

const fileSearchResultSchema = z.object({
  path: z.string().min(1),
  glob: z.string().min(1),
  query: z.string().min(1).nullable(),
  matches: z.array(
    z.object({
      path: z.string().min(1),
      line: z.number().int().min(1).nullable(),
      column: z.number().int().min(1).nullable(),
      preview: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
  scannedFiles: z.number().int().nonnegative(),
  skippedBinary: z.number().int().nonnegative(),
  skippedOversized: z.number().int().nonnegative(),
});

const fileWriteResultSchema = z.object({
  path: z.string().min(1),
  created: z.boolean(),
  previousSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytesWritten: z.number().int().nonnegative(),
  durability: z.enum(['file-and-directory', 'file-only']),
});

const filePatchResultSchema = z.object({
  path: z.string().min(1),
  previousSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  editsApplied: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
  durability: z.enum(['file-and-directory', 'file-only']),
});

const filesystemErrorOutputSchema = z.object({
  ok: z.literal(false),
  errorCode: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});

const fileReadToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), file: fileReadResultSchema }),
  filesystemErrorOutputSchema,
]);

const fileListToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), listing: fileListResultSchema }),
  filesystemErrorOutputSchema,
]);

const fileSearchToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), search: fileSearchResultSchema }),
  filesystemErrorOutputSchema,
]);

const fileWriteToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), write: fileWriteResultSchema }),
  filesystemErrorOutputSchema,
]);

const filePatchToolOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), patch: filePatchResultSchema }),
  filesystemErrorOutputSchema,
]);

export interface StartMcpEdgeOptions {
  daemonSocketPath: string;
  host?: '127.0.0.1' | '::1';
  port?: number;
}

export interface McpEdgeHandle {
  readonly url: URL;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startMcpEdge(options: StartMcpEdgeOptions): Promise<McpEdgeHandle> {
  if (options.daemonSocketPath.length === 0) {
    throw new TypeError('daemonSocketPath must not be empty');
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('port must be an integer between 0 and 65535');
  }

  const daemonClient = createLocalRpcClient({ socketPath: options.daemonSocketPath });
  const handler = createMcpHandler(() => buildMcpServer(daemonClient));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer((request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    void nodeHandler(request as NodeIncomingMessageLike, response as NodeServerResponseLike);
  });

  try {
    await listen(server, host, port);
  } catch (error) {
    await handler.close();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await handler.close();
    await closeServer(server);
    throw new Error('MCP edge did not expose a TCP listening address');
  }

  const bound = address as AddressInfo;
  const urlHost = bound.family === 'IPv6' ? `[${bound.address}]` : bound.address;
  const url = new URL(`http://${urlHost}:${bound.port}/mcp`);
  let closed = false;

  return {
    url,
    host: bound.address,
    port: bound.port,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await handler.close();
      await closeServer(server);
    },
  };
}

function buildMcpServer(daemonClient: ReturnType<typeof createLocalRpcClient>): McpServer {
  const server = new McpServer(
    { name: 'benchhand', version: EDGE_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.registerTool(
    'capabilities',
    {
      title: 'Benchhand Capabilities',
      description: 'Report the protocol eras and durable core features supported by Benchhand.',
      inputSchema: z.object({}),
      outputSchema: capabilitiesOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async () => {
      const output = {
        protocolVersions: [MODERN_PROTOCOL_VERSION],
        protocolEras: ['legacy', 'modern'] as const,
        durableOperations: true as const,
        localRpcSchemaVersion: 1 as const,
      };
      return toolSuccess(output);
    },
  );

  server.registerTool(
    'health',
    {
      title: 'Benchhand Health',
      description: 'Verify that the MCP edge can reach the durable UDM core daemon.',
      inputSchema: z.object({}),
      outputSchema: healthToolOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async () => {
      try {
        const raw = await daemonClient.call({
          requestId: `edge_health_${randomUUID()}`,
          method: 'system.health',
          params: {},
          deadlineUnixMs: Date.now() + 5_000,
        });
        const health = daemonHealthSchema.parse(raw);
        return toolSuccess({
          status: 'healthy' as const,
          live: health.live,
          ready: health.ready,
          rpcSchemaVersion: health.rpcSchemaVersion,
          storageIntegrity: health.storageIntegrity,
        });
      } catch (error) {
        const output =
          error instanceof RpcCallError
            ? {
                status: 'unavailable' as const,
                errorCode: error.code,
                retryable: error.retryable,
              }
            : {
                status: 'unavailable' as const,
                errorCode: 'CORE_FAILURE',
                retryable: false,
              };

        return {
          ...toolSuccess(output),
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'system_info',
    {
      title: 'Benchhand System Info',
      description: 'Report the MCP edge runtime and platform without mutating project state.',
      inputSchema: z.object({}),
      outputSchema: systemInfoOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async () =>
      toolSuccess({
        edgeVersion: EDGE_VERSION,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
      }),
  );

  server.registerTool(
    'file_read',
    {
      title: 'Read File',
      description:
        'Read a bounded byte range from a workspace-relative regular file with text/binary classification.',
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        path: z.string().min(1),
        offset: z.number().int().nonnegative().optional(),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024)
          .optional(),
      }),
      outputSchema: fileReadToolOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (params) =>
      callFilesystemRpc(
        daemonClient,
        'file.read',
        definedParams(params),
        fileReadResultSchema,
        'file',
      ),
  );

  server.registerTool(
    'file_list',
    {
      title: 'List Files',
      description:
        'List workspace-relative directory entries in deterministic order with bounded cursor pagination.',
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        path: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        cursor: z.string().min(1).optional(),
      }),
      outputSchema: fileListToolOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (params) =>
      callFilesystemRpc(
        daemonClient,
        'file.list',
        definedParams(params),
        fileListResultSchema,
        'listing',
      ),
  );

  server.registerTool(
    'file_search',
    {
      title: 'Search Files',
      description:
        'Search workspace-relative files with bounded glob and literal-text matching without following symlink directories.',
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        path: z.string().optional(),
        glob: z.string().min(1).max(1024).optional(),
        query: z.string().min(1).max(4096).optional(),
        maxResults: z.number().int().min(1).max(1000).optional(),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024)
          .optional(),
        maxDepth: z.number().int().min(0).max(100).optional(),
        maxFileBytes: z
          .number()
          .int()
          .min(1)
          .max(8 * 1024 * 1024)
          .optional(),
      }),
      outputSchema: fileSearchToolOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (params) =>
      callFilesystemRpc(
        daemonClient,
        'file.search',
        definedParams(params),
        fileSearchResultSchema,
        'search',
      ),
  );

  server.registerTool(
    'file_write',
    {
      title: 'Write File Atomically',
      description:
        'Atomically replace or create a workspace-relative text file with optional SHA-256 precondition conflict detection.',
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        path: z.string().min(1),
        content: z.string(),
        expectedSha256: z
          .string()
          .regex(/^[0-9a-fA-F]{64}$/)
          .nullable()
          .optional(),
      }),
      outputSchema: fileWriteToolOutputSchema,
      annotations: workspaceOpenAnnotations(),
    },
    async (params) =>
      callFilesystemRpc(
        daemonClient,
        'file.write',
        definedParams(params),
        fileWriteResultSchema,
        'write',
      ),
  );

  server.registerTool(
    'file_patch',
    {
      title: 'Patch File Deterministically',
      description:
        'Apply exact non-overlapping text edits to a workspace-relative file only when its SHA-256 precondition matches. Ambiguous, missing, overlapping, stale, or binary targets fail without fuzzy fallback.',
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        path: z.string().min(1),
        expectedSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
        edits: z
          .array(
            z.object({
              oldText: z.string().min(1),
              newText: z.string(),
            }),
          )
          .min(1)
          .max(256),
      }),
      outputSchema: filePatchToolOutputSchema,
      annotations: workspaceOpenAnnotations(),
    },
    async ({ workspaceId, path, expectedSha256, edits }) =>
      callFilesystemRpc(
        daemonClient,
        'file.patch',
        { workspaceId, path, expectedSha256, edits },
        filePatchResultSchema,
        'patch',
      ),
  );

  server.registerTool(
    'workspace_get',
    {
      title: 'Get Workspace',
      description: 'Read a durable workspace handle and refresh its filesystem availability.',
      inputSchema: z.object({ workspaceId: z.string().min(1) }),
      outputSchema: workspaceToolOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ workspaceId }) => callWorkspaceRpc(daemonClient, 'workspace.get', { workspaceId }),
  );

  server.registerTool(
    'workspace_open',
    {
      title: 'Open Workspace',
      description:
        'Open or reuse a checkout workspace or a Benchhand-managed Git worktree and return its durable handle.',
      inputSchema: z.object({
        path: z.string().min(1),
        mode: z.enum(['checkout', 'worktree']).optional(),
        baseRef: z.string().min(1).optional(),
      }),
      outputSchema: workspaceToolOutputSchema,
      annotations: workspaceOpenAnnotations(),
    },
    async ({ path, mode, baseRef }) =>
      callWorkspaceRpc(daemonClient, 'workspace.open', {
        path,
        ...(mode === undefined ? {} : { mode }),
        ...(baseRef === undefined ? {} : { baseRef }),
      }),
  );

  return server;
}

async function callFilesystemRpc(
  daemonClient: ReturnType<typeof createLocalRpcClient>,
  method: 'file.read' | 'file.list' | 'file.search' | 'file.write' | 'file.patch',
  params: Record<string, JsonValue>,
  schema: z.ZodType,
  resultKey: 'file' | 'listing' | 'search' | 'write' | 'patch',
) {
  try {
    const raw = await daemonClient.call({
      requestId: `edge_filesystem_${randomUUID()}`,
      method,
      params,
      deadlineUnixMs: Date.now() + 5_000,
    });
    const result = schema.parse(raw);
    return toolSuccess({ ok: true as const, [resultKey]: result });
  } catch (error) {
    const output =
      error instanceof RpcCallError
        ? {
            ok: false as const,
            errorCode: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.details === undefined ? {} : { details: error.details }),
          }
        : {
            ok: false as const,
            errorCode: 'CORE_FAILURE',
            message: error instanceof Error ? error.message : 'Filesystem RPC failed',
            retryable: false,
          };
    return {
      ...toolSuccess(output),
      isError: true,
    };
  }
}

function definedParams(value: Record<string, unknown>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      result[key] = item;
      continue;
    }
    throw new TypeError(`MCP tool parameter ${key} is not a JSON primitive`);
  }
  return result;
}

async function callWorkspaceRpc(
  daemonClient: ReturnType<typeof createLocalRpcClient>,
  method: 'workspace.get' | 'workspace.open',
  params: Record<string, string>,
) {
  try {
    const raw = await daemonClient.call({
      requestId: `edge_workspace_${randomUUID()}`,
      method,
      params,
      deadlineUnixMs: Date.now() + 5_000,
    });
    const workspace = parseWorkspaceRecord(raw);
    return toolSuccess({ ok: true as const, workspace });
  } catch (error) {
    const output =
      error instanceof RpcCallError
        ? {
            ok: false as const,
            errorCode: error.code,
            message: error.message,
            retryable: error.retryable,
          }
        : {
            ok: false as const,
            errorCode: 'CORE_FAILURE',
            message: error instanceof Error ? error.message : 'Workspace RPC failed',
            retryable: false,
          };
    return {
      ...toolSuccess(output),
      isError: true,
    };
  }
}

function readOnlyAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
}

function workspaceOpenAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  } as const;
}

function toolSuccess<Output extends Record<string, unknown>>(output: Output) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function listen(server: Server, host: string, port: number): Promise<void> {
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
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
