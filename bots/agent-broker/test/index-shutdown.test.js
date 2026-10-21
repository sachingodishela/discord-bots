import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdownCoordinator } from '../src/index.js';
import { createLogger } from '../src/logger.js';

const silentLogger = createLogger({ logLevel: 'error' }, { write: () => {} });

function makeFakeBroker(overrides = {}) {
  return {
    shutdownCalls: 0,
    async shutdown() {
      this.shutdownCalls += 1;
      if (overrides.shutdownError) throw overrides.shutdownError;
    },
    ...overrides,
  };
}

describe('createShutdownCoordinator', () => {
  test('a fatal-triggered shutdown exits with a non-zero code', async () => {
    const broker = makeFakeBroker();
    const exitCalls = [];
    const shutdown = createShutdownCoordinator({ logger: silentLogger, broker, exit: (code) => exitCalls.push(code) });

    await shutdown('fatal-gateway-error', 1);

    assert.equal(broker.shutdownCalls, 1);
    assert.deepEqual(exitCalls, [1]);
  });

  test('a signal-triggered (SIGTERM/SIGINT) shutdown exits with code 0', async () => {
    const broker = makeFakeBroker();
    const exitCalls = [];
    const shutdown = createShutdownCoordinator({ logger: silentLogger, broker, exit: (code) => exitCalls.push(code) });

    await shutdown('SIGTERM', 0);

    assert.equal(broker.shutdownCalls, 1);
    assert.deepEqual(exitCalls, [0]);
  });

  test('exitCode defaults to 0 when omitted (clean shutdown)', async () => {
    const broker = makeFakeBroker();
    const exitCalls = [];
    const shutdown = createShutdownCoordinator({ logger: silentLogger, broker, exit: (code) => exitCalls.push(code) });

    await shutdown('SIGINT');

    assert.deepEqual(exitCalls, [0]);
  });

  test('is idempotent: a second call (even with a different reason/code) is a no-op', async () => {
    const broker = makeFakeBroker();
    const exitCalls = [];
    const shutdown = createShutdownCoordinator({ logger: silentLogger, broker, exit: (code) => exitCalls.push(code) });

    await shutdown('fatal-gateway-error', 1);
    await shutdown('SIGTERM', 0); // must NOT downgrade the earlier fatal exit

    assert.equal(broker.shutdownCalls, 1, 'broker.shutdown() must only run once');
    assert.deepEqual(exitCalls, [1], 'the second call must not invoke exit again');
  });

  test('a fatal shutdown that races with a concurrent clean-shutdown call still exits non-zero once', async () => {
    const broker = makeFakeBroker();
    const exitCalls = [];
    const shutdown = createShutdownCoordinator({ logger: silentLogger, broker, exit: (code) => exitCalls.push(code) });

    // Simulate the gateway's 'fatal' handler and a SIGTERM arriving back to back
    // before either shutdown() call has finished awaiting broker.shutdown().
    await Promise.all([shutdown('fatal-gateway-error', 1), shutdown('SIGTERM', 0)]);

    assert.equal(broker.shutdownCalls, 1);
    assert.deepEqual(exitCalls, [1], 'the fatal exit code must win, never silently become 0');
  });

  test('even if broker.shutdown() throws, exit is still called with the requested code', async () => {
    const broker = makeFakeBroker({ shutdownError: new Error('teardown failed') });
    const exitCalls = [];
    const shutdown = createShutdownCoordinator({ logger: silentLogger, broker, exit: (code) => exitCalls.push(code) });

    await shutdown('fatal-gateway-error', 1);

    assert.deepEqual(exitCalls, [1]);
  });
});
