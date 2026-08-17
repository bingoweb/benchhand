import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEntityId } from '../src/ids.js';

test('rejects an empty durable entity id', () => {
  assert.throws(
    () => parseEntityId('workspace', ''),
    /workspace id must not be empty/,
  );
});

test('preserves a valid durable entity id exactly', () => {
  const value = 'ws_01JABCDEF1234567890';

  assert.equal(parseEntityId('workspace', value), value);
});
