import http from 'node:http';

import {
  type JsonValue,
  parseRpcRequest,
  parseRpcResponse,
  RPC_SCHEMA_VERSION,
  type RpcError,
  type RpcRequest,
} from '@benchhand/contracts';

const MAX_RESPONSE_BYTES = 1024 * 1024;

export class RpcCallError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(error: RpcError) {
    super(error.message);
    this.name = 'RpcCallError';
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}

export interface LocalRpcClientOptions {
  socketPath: string;
}

export interface RpcCallOptions {
  signal?: AbortSignal;
}

export type RpcCallRequest = Omit<RpcRequest, 'schemaVersion'>;

export interface LocalRpcClient {
  call<Result extends JsonValue = JsonValue>(
    request: RpcCallRequest,
    options?: RpcCallOptions,
  ): Promise<Result>;
}

export function createLocalRpcClient(options: LocalRpcClientOptions): LocalRpcClient {
  if (options.socketPath.length === 0) {
    throw new TypeError('socketPath must not be empty');
  }

  return {
    async call<Result extends JsonValue = JsonValue>(
      request: RpcCallRequest,
      callOptions: RpcCallOptions = {},
    ): Promise<Result> {
      const wireRequest = parseRpcRequest({
        ...request,
        schemaVersion: RPC_SCHEMA_VERSION,
      });

      if (wireRequest.deadlineUnixMs !== undefined && wireRequest.deadlineUnixMs <= Date.now()) {
        throw new RpcCallError({
          code: 'TIMEOUT',
          message: 'RPC deadline exceeded before transport',
          retryable: true,
        });
      }

      if (callOptions.signal?.aborted === true) {
        throw new RpcCallError({
          code: 'CANCELLED',
          message: 'RPC call was cancelled before transport',
          retryable: false,
        });
      }

      return requestOverIpc<Result>(options.socketPath, wireRequest, callOptions.signal);
    },
  };
}

function requestOverIpc<Result extends JsonValue>(
  socketPath: string,
  wireRequest: RpcRequest,
  callerSignal: AbortSignal | undefined,
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    let cancelledByCaller = false;
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;

    const onCallerAbort = (): void => {
      cancelledByCaller = true;
      controller.abort();
    };

    const cleanup = (): void => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      callerSignal?.removeEventListener('abort', onCallerAbort);
    };

    const settleResolve = (value: Result): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    if (wireRequest.deadlineUnixMs !== undefined) {
      const delayMs = Math.max(0, wireRequest.deadlineUnixMs - Date.now());
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, delayMs);
    }

    const payload = Buffer.from(JSON.stringify(wireRequest));
    const clientRequest = http.request(
      {
        method: 'POST',
        path: '/rpc',
        socketPath,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': payload.byteLength,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;

        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('RPC response exceeds maximum size'));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          try {
            const decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            const wireResponse = parseRpcResponse(decoded);
            if (wireResponse.requestId !== wireRequest.requestId) {
              throw new RpcCallError({
                code: 'TRANSPORT_FAILURE',
                message: 'RPC response requestId does not match the request',
                retryable: true,
              });
            }

            if (!wireResponse.ok) {
              throw new RpcCallError(wireResponse.error);
            }

            settleResolve(wireResponse.result as Result);
          } catch (error) {
            if (error instanceof RpcCallError) {
              settleReject(error);
              return;
            }
            settleReject(
              new RpcCallError({
                code: 'TRANSPORT_FAILURE',
                message: error instanceof Error ? error.message : 'Invalid RPC response',
                retryable: true,
              }),
            );
          }
        });

        response.on('error', (error) => {
          settleReject(
            new RpcCallError({
              code: 'TRANSPORT_FAILURE',
              message: error.message,
              retryable: true,
            }),
          );
        });
      },
    );

    clientRequest.on('error', (error: NodeJS.ErrnoException) => {
      if (timedOut) {
        settleReject(
          new RpcCallError({
            code: 'TIMEOUT',
            message: 'RPC deadline exceeded',
            retryable: true,
          }),
        );
        return;
      }
      if (cancelledByCaller) {
        settleReject(
          new RpcCallError({
            code: 'CANCELLED',
            message: 'RPC call was cancelled',
            retryable: false,
          }),
        );
        return;
      }

      const unavailableCodes = new Set(['ECONNREFUSED', 'ENOENT', 'EPIPE', 'ECONNRESET']);
      if (error.code !== undefined && unavailableCodes.has(error.code)) {
        settleReject(
          new RpcCallError({
            code: 'CORE_UNAVAILABLE',
            message: 'UDM core daemon is unavailable',
            retryable: true,
          }),
        );
        return;
      }

      settleReject(
        new RpcCallError({
          code: 'TRANSPORT_FAILURE',
          message: error.message,
          retryable: true,
        }),
      );
    });

    clientRequest.end(payload);
  });
}
