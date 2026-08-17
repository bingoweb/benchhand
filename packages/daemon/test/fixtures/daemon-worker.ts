import { startDaemon } from '../../src/index.js';

const databasePath = process.env.UDMCP_TEST_DB;
const socketPath = process.env.UDMCP_TEST_SOCKET;
if (databasePath === undefined || socketPath === undefined) {
  throw new Error('UDMCP_TEST_DB and UDMCP_TEST_SOCKET are required');
}

const daemon = await startDaemon({ databasePath, socketPath });
process.send?.({ instanceId: daemon.instanceId });
setInterval(() => {}, 1_000);
