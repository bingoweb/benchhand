import { parseEntityId } from '@udmcp/contracts';
import { openSqliteDatabase } from '@udmcp/storage';

import { OperationJournal } from '../../src/index.js';

const path = process.env.UDMCP_TEST_DB;
if (path === undefined) {
  throw new Error('UDMCP_TEST_DB is required');
}

const db = openSqliteDatabase(path);
const journal = new OperationJournal(db);
const operationId = parseEntityId('operation', 'op_sigkill');

const claim = journal.prepare({
  operationId,
  kind: 'fixture.sigkill',
  fingerprint: 'sha256:sigkill-v1',
});

if (claim.disposition !== 'execute') {
  throw new Error(`unexpected claim disposition: ${claim.disposition}`);
}

journal.markRunning(operationId);
process.send?.({ state: 'running' });
setInterval(() => {}, 1_000);
