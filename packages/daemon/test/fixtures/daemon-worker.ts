import { startDaemon } from '../../src/index.js';

const databasePath = process.env.BENCHHAND_TEST_DB;
const socketPath = process.env.BENCHHAND_TEST_SOCKET;
if (databasePath === undefined || socketPath === undefined) {
  throw new Error('BENCHHAND_TEST_DB and BENCHHAND_TEST_SOCKET are required');
}

const daemon = await startDaemon({ databasePath, socketPath });
process.send?.({ instanceId: daemon.instanceId });
setInterval(() => {}, 1_000);
