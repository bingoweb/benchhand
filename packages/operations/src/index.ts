import {
  type EntityVersion,
  type JsonValue,
  type OperationId,
  type OperationState,
  parseEntityId,
  parseEntityVersion,
  parseOperationState,
  parseResultEnvelope,
} from '@udmcp/contracts';
import type { SqliteDatabase } from '@udmcp/storage';

const OPERATION_JOURNAL_MIGRATION = {
  id: '0001-operation-journal',
  sql: `
    CREATE TABLE operation_journal (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN (
          'accepted',
          'running',
          'committed',
          'failed',
          'unknown-needs-reconcile',
          'rolled_back'
        )
      ),
      result_json TEXT,
      error_json TEXT,
      version INTEGER NOT NULL CHECK (version >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE INDEX operation_journal_state_idx
      ON operation_journal(state);
  `,
} as const;

export interface OperationRequest {
  operationId: OperationId;
  kind: string;
  fingerprint: string;
}

export interface SerializedOperationError {
  name: string;
  message: string;
}

export interface OperationRecord {
  operationId: OperationId;
  kind: string;
  fingerprint: string;
  state: OperationState;
  version: EntityVersion;
  result?: JsonValue;
  error?: SerializedOperationError;
}

export type PrepareOutcome =
  | { disposition: 'execute'; state: 'accepted' }
  | { disposition: 'replay'; record: OperationRecord }
  | { disposition: 'in-progress'; state: 'accepted' | 'running' }
  | {
      disposition: 'reconcile-required';
      state: 'unknown-needs-reconcile';
    };

export type OperationExecutionOutcome<Result extends JsonValue> =
  | { disposition: 'executed'; state: 'committed'; result: Result }
  | { disposition: 'replayed'; state: 'committed'; result: Result }
  | {
      disposition: 'replayed';
      state: 'failed';
      error: SerializedOperationError;
    }
  | { disposition: 'replayed'; state: 'rolled_back' }
  | { disposition: 'in-progress'; state: 'accepted' | 'running' }
  | {
      disposition: 'reconcile-required';
      state: 'unknown-needs-reconcile';
    };

type OperationRow = {
  operation_id: string;
  kind: string;
  fingerprint: string;
  state: string;
  result_json: string | null;
  error_json: string | null;
  version: number;
} & Record<string, unknown>;

export class OperationConflictError extends Error {
  readonly code = 'CONFLICT';

  constructor(operationId: OperationId) {
    super(`operation id ${operationId} is already bound to different input`);
    this.name = 'OperationConflictError';
  }
}

export class OperationJournal {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
    this.#database.applyMigrations([OPERATION_JOURNAL_MIGRATION]);
  }

  prepare(request: OperationRequest): PrepareOutcome {
    return this.#database.transaction(() => {
      const existing = this.#read(request.operationId);
      if (existing !== undefined) {
        if (existing.kind !== request.kind || existing.fingerprint !== request.fingerprint) {
          throw new OperationConflictError(request.operationId);
        }

        if (
          existing.state === 'committed' ||
          existing.state === 'failed' ||
          existing.state === 'rolled_back'
        ) {
          return { disposition: 'replay', record: existing };
        }

        if (existing.state === 'unknown-needs-reconcile') {
          return {
            disposition: 'reconcile-required',
            state: existing.state,
          };
        }

        return { disposition: 'in-progress', state: existing.state };
      }

      this.#database.run(
        `
          INSERT INTO operation_journal(
            operation_id,
            kind,
            fingerprint,
            state,
            version
          ) VALUES (?, ?, ?, 'accepted', 0)
        `,
        [request.operationId, request.kind, request.fingerprint],
      );

      return { disposition: 'execute', state: 'accepted' };
    });
  }

  markRunning(operationId: OperationId): void {
    const result = this.#database.run(
      `
        UPDATE operation_journal
        SET state = 'running',
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE operation_id = ? AND state = 'accepted'
      `,
      [operationId],
    );

    if (result.changes !== 1) {
      throw new Error(`operation ${operationId} is not in accepted state`);
    }
  }

  reconcileInterrupted(): number {
    const result = this.#database.run(`
      UPDATE operation_journal
      SET state = 'unknown-needs-reconcile',
          version = version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE state IN ('accepted', 'running')
    `);
    return result.changes;
  }

  get(operationId: OperationId): OperationRecord | undefined {
    return this.#read(operationId);
  }

  async execute<Result extends JsonValue>(
    request: OperationRequest,
    effect: () => Promise<Result> | Result,
  ): Promise<OperationExecutionOutcome<Result>> {
    const prepared = this.prepare(request);

    if (prepared.disposition === 'in-progress') {
      return prepared;
    }
    if (prepared.disposition === 'reconcile-required') {
      return prepared;
    }
    if (prepared.disposition === 'replay') {
      const { record } = prepared;
      if (record.state === 'committed') {
        if (record.result === undefined) {
          throw new Error(`committed operation ${request.operationId} has no result`);
        }
        return {
          disposition: 'replayed',
          state: 'committed',
          result: record.result as Result,
        };
      }
      if (record.state === 'failed') {
        if (record.error === undefined) {
          throw new Error(`failed operation ${request.operationId} has no error`);
        }
        return {
          disposition: 'replayed',
          state: 'failed',
          error: record.error,
        };
      }
      return { disposition: 'replayed', state: 'rolled_back' };
    }

    this.markRunning(request.operationId);
    try {
      const result = await effect();
      const wireResult = parseResultEnvelope({ ok: true, result }).result as Result;
      this.#markCommitted(request.operationId, wireResult);
      return { disposition: 'executed', state: 'committed', result: wireResult };
    } catch (error) {
      this.#markFailed(request.operationId, serializeError(error));
      throw error;
    }
  }

  #markCommitted(operationId: OperationId, result: JsonValue): void {
    const encoded = JSON.stringify(result);
    const update = this.#database.run(
      `
        UPDATE operation_journal
        SET state = 'committed',
            result_json = ?,
            error_json = NULL,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE operation_id = ? AND state = 'running'
      `,
      [encoded, operationId],
    );
    if (update.changes !== 1) {
      throw new Error(`operation ${operationId} could not be committed`);
    }
  }

  #markFailed(operationId: OperationId, error: SerializedOperationError): void {
    const update = this.#database.run(
      `
        UPDATE operation_journal
        SET state = 'failed',
            result_json = NULL,
            error_json = ?,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE operation_id = ? AND state = 'running'
      `,
      [JSON.stringify(error), operationId],
    );
    if (update.changes !== 1) {
      throw new Error(`operation ${operationId} could not be marked failed`);
    }
  }

  #read(operationId: OperationId): OperationRecord | undefined {
    const row = this.#database.get<OperationRow>(
      `
        SELECT
          operation_id,
          kind,
          fingerprint,
          state,
          result_json,
          error_json,
          version
        FROM operation_journal
        WHERE operation_id = ?
      `,
      [operationId],
    );

    if (row === undefined) {
      return undefined;
    }

    const record: OperationRecord = {
      operationId: parseEntityId('operation', row.operation_id),
      kind: row.kind,
      fingerprint: row.fingerprint,
      state: parseOperationState(row.state),
      version: parseEntityVersion(row.version),
    };

    if (row.result_json !== null) {
      record.result = parseResultEnvelope({
        ok: true,
        result: JSON.parse(row.result_json) as unknown,
      }).result as JsonValue;
    }
    if (row.error_json !== null) {
      record.error = parseSerializedError(row.error_json);
    }

    return record;
  }
}

function serializeError(error: unknown): SerializedOperationError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Error', message: String(error) };
}

function parseSerializedError(encoded: string): SerializedOperationError {
  const value = JSON.parse(encoded) as unknown;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('name' in value) ||
    !('message' in value) ||
    typeof value.name !== 'string' ||
    typeof value.message !== 'string'
  ) {
    throw new Error('operation journal contains invalid serialized error data');
  }

  return { name: value.name, message: value.message };
}
