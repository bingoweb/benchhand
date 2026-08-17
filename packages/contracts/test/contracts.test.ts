import assert from 'node:assert/strict';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  CapabilityDescriptorSchema,
  ErrorEnvelopeSchema,
  MutationMetadataSchema,
  OperationStateSchema,
  parseCapabilityDescriptor,
  parseEntityVersion,
  parseErrorEnvelope,
  parseHealthState,
  parseMutationMetadata,
  parseOperationState,
  parseResultEnvelope,
  ResultEnvelopeSchema,
} from '../src/contracts.js';

test('result envelope survives a JSON serialization roundtrip', () => {
  const input = {
    ok: true,
    result: {
      workspaceId: 'ws_01JABCDEF1234567890',
      reused: true,
    },
  };

  const wireValue = JSON.parse(JSON.stringify(input)) as unknown;

  assert.deepEqual(parseResultEnvelope(wireValue), input);
});

test('result envelope rejects values that cannot exist on a JSON wire', () => {
  assert.throws(
    () => parseResultEnvelope({ ok: true, result: () => 'not-json' }),
    /invalid result envelope/i,
  );
});

test('result envelope accepts repeated acyclic object references', () => {
  const shared = { value: 7 };
  const input = { ok: true, result: { first: shared, second: shared } };

  assert.deepEqual(parseResultEnvelope(input), input);
});

test('error envelope rejects malformed machine-readable errors', () => {
  assert.throws(
    () =>
      parseErrorEnvelope({
        ok: false,
        error: {
          code: 'CORE_UNAVAILABLE',
          message: 'daemon is unavailable',
          retryable: 'yes',
        },
      }),
    /invalid error envelope/i,
  );
});

test('health state is a closed contract', () => {
  assert.equal(parseHealthState('healthy'), 'healthy');
  assert.throws(() => parseHealthState('mostly-fine'), /invalid health state/i);
});

test('entity version is a non-negative integer', () => {
  assert.equal(parseEntityVersion(0), 0);
  assert.equal(parseEntityVersion(42), 42);
  assert.throws(() => parseEntityVersion(-1), /invalid entity version/i);
  assert.throws(() => parseEntityVersion(1.5), /invalid entity version/i);
});

test('capability descriptor preserves provider health and features', () => {
  const input = {
    capability: 'remote.filesystem',
    provider: 'org.taylan.persistent-terminal',
    providerVersion: '0.12.0',
    health: 'healthy',
    features: ['read', 'write', 'patch', 'hash', 'sync'],
  };

  assert.deepEqual(parseCapabilityDescriptor(input), input);
});

test('mutation metadata is explicit about retry and danger semantics', () => {
  const input = {
    readOnly: false,
    idempotent: true,
    dangerous: false,
    requiresOperationId: true,
  };

  assert.deepEqual(parseMutationMetadata(input), input);
});

test('operation journal state is a closed durable contract', () => {
  assert.equal(parseOperationState('accepted'), 'accepted');
  assert.equal(parseOperationState('unknown-needs-reconcile'), 'unknown-needs-reconcile');
  assert.equal(parseOperationState('rolled_back'), 'rolled_back');
  assert.throws(() => parseOperationState('retry-it-probably'), /invalid operation state/i);
});

test('wire schemas are valid JSON Schema 2020-12 and reject extra fields', () => {
  const ajv = new Ajv2020({ strict: true });

  const validateResult = ajv.compile(ResultEnvelopeSchema);
  const validateError = ajv.compile(ErrorEnvelopeSchema);
  const validateCapability = ajv.compile(CapabilityDescriptorSchema);
  const validateMutation = ajv.compile(MutationMetadataSchema);
  const validateOperationState = ajv.compile(OperationStateSchema);

  assert.equal(validateResult({ ok: true, result: { value: 1 } }), true);
  assert.equal(validateResult({ ok: true, result: { value: 1 }, unexpected: true }), false);
  assert.equal(
    validateError({
      ok: false,
      error: {
        code: 'CORE_UNAVAILABLE',
        message: 'daemon is unavailable',
        retryable: true,
      },
    }),
    true,
  );
  assert.equal(validateCapability({ capability: 'x', provider: 'y' }), false);
  assert.equal(
    validateMutation({
      readOnly: true,
      idempotent: true,
      dangerous: false,
      requiresOperationId: false,
    }),
    true,
  );
  assert.equal(validateOperationState('committed'), true);
  assert.equal(validateOperationState('maybe'), false);
});
