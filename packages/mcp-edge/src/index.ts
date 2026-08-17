import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  localhostHostValidation,
  localhostOriginValidation,
  type NodeIncomingMessageLike,
  type NodeServerResponseLike,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { parseWorkspaceRecord } from '@udmcp/contracts';
import { createLocalRpcClient, RpcCallError } from '@udmcp/local-rpc';
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
  mode: z.literal('checkout'),
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
    { name: 'udmcp', version: EDGE_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.registerTool(
    'capabilities',
    {
      title: 'UDMCP Capabilities',
      description: 'Report the protocol eras and durable core features supported by UDMCP.',
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
      title: 'UDMCP Health',
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
      title: 'UDMCP System Info',
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
        'Open or reuse an existing checkout workspace by canonical path and return its durable handle.',
      inputSchema: z.object({ path: z.string().min(1) }),
      outputSchema: workspaceToolOutputSchema,
      annotations: workspaceOpenAnnotations(),
    },
    async ({ path }) => callWorkspaceRpc(daemonClient, 'workspace.open', { path }),
  );

  return server;
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
