import net from 'node:net';

const socketPath = process.env.BENCHHAND_TEST_SOCKET;
if (socketPath === undefined) {
  throw new Error('BENCHHAND_TEST_SOCKET is required');
}

const server = net.createServer();
server.listen(socketPath, () => process.send?.({ state: 'listening' }));
setInterval(() => {}, 1_000);
