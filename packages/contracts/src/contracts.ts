import Type, { type Static, type TSchema } from 'typebox';
import Value from 'typebox/value';

import type { DurableEntityId } from './ids.js';

const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WorkspaceId = DurableEntityId<'workspace'>;
export type OperationId = DurableEntityId<'operation'>;
export type ProcessId = DurableEntityId<'process'>;
export type TaskId = DurableEntityId<'task'>;
export type TerminalSessionId = DurableEntityId<'terminal-session'>;
export type PluginId = DurableEntityId<'plugin'>;
export type PluginInstanceId = DurableEntityId<'plugin-instance'>;
export type ArtifactId = DurableEntityId<'artifact'>;

declare const entityVersionBrand: unique symbol;

export type EntityVersion = number & {
  readonly [entityVersionBrand]: 'entity-version';
};

export const HealthStateSchema = Type.Union(
  [
    Type.Literal('starting'),
    Type.Literal('healthy'),
    Type.Literal('degraded'),
    Type.Literal('unhealthy'),
    Type.Literal('unknown'),
    Type.Literal('stopping'),
  ],
  { $schema: JSON_SCHEMA_2020_12 },
);

export type HealthState = Static<typeof HealthStateSchema>;

export const EntityVersionSchema = Type.Integer({
  $schema: JSON_SCHEMA_2020_12,
  minimum: 0,
});

export const CapabilityDescriptorSchema = Type.Object(
  {
    capability: Type.String({ minLength: 1, maxLength: 128 }),
    provider: Type.String({ minLength: 1, maxLength: 256 }),
    providerVersion: Type.String({ minLength: 1, maxLength: 128 }),
    health: HealthStateSchema,
    features: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      uniqueItems: true,
    }),
  },
  {
    $schema: JSON_SCHEMA_2020_12,
    additionalProperties: false,
  },
);

export type CapabilityDescriptor = Static<typeof CapabilityDescriptorSchema>;

export const MutationMetadataSchema = Type.Object(
  {
    readOnly: Type.Boolean(),
    idempotent: Type.Boolean(),
    dangerous: Type.Boolean(),
    requiresOperationId: Type.Boolean(),
  },
  {
    $schema: JSON_SCHEMA_2020_12,
    additionalProperties: false,
  },
);

export type MutationMetadata = Static<typeof MutationMetadataSchema>;

export const ErrorEnvelopeSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 128 }),
        message: Type.String({ minLength: 1 }),
        retryable: Type.Boolean(),
        details: Type.Optional(Type.Unknown()),
      },
      { additionalProperties: false },
    ),
    requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  {
    $schema: JSON_SCHEMA_2020_12,
    additionalProperties: false,
  },
);

export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export const ResultEnvelopeSchema = Type.Object(
  {
    ok: Type.Literal(true),
    result: Type.Unknown(),
    requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  {
    $schema: JSON_SCHEMA_2020_12,
    additionalProperties: false,
  },
);

export type ResultEnvelope<Result = unknown> = {
  ok: true;
  result: Result;
  requestId?: string;
};

function parseSchema<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string,
): Static<Schema> {
  if (!isJsonValue(value) || !Value.Check(schema, value)) {
    throw new TypeError(`invalid ${label}`);
  }

  return value as Static<Schema>;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (typeof value !== 'object') {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const valid = value.every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return valid;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return false;
  }

  const valid = Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

export function parseResultEnvelope(value: unknown): ResultEnvelope {
  return parseSchema(ResultEnvelopeSchema, value, 'result envelope');
}

export function parseErrorEnvelope(value: unknown): ErrorEnvelope {
  return parseSchema(ErrorEnvelopeSchema, value, 'error envelope');
}

export function parseHealthState(value: unknown): HealthState {
  return parseSchema(HealthStateSchema, value, 'health state');
}

export function parseEntityVersion(value: unknown): EntityVersion {
  return parseSchema(
    EntityVersionSchema,
    value,
    'entity version',
  ) as EntityVersion;
}

export function parseCapabilityDescriptor(
  value: unknown,
): CapabilityDescriptor {
  return parseSchema(CapabilityDescriptorSchema, value, 'capability descriptor');
}

export function parseMutationMetadata(value: unknown): MutationMetadata {
  return parseSchema(MutationMetadataSchema, value, 'mutation metadata');
}
