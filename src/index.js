#!/usr/bin/env node
/**
 * Entry point: wires config, logger, state store, Discord REST/Gateway
 * clients, and the Broker; handles graceful shutdown on SIGTERM/SIGINT.
 */
import { loadConfig, resolveRuntimeEnvironment, ConfigError } from './config.js';
import { createLogger } from './logger.js';
import { StateStore, StateCorruptError } from './state/store.js';
import { DiscordRestClient } from './discord/rest.js';
import { GatewayClient } from './discord/gateway.js';
import { Broker } from './broker.js';

/**
 * Creates a shutdown coordinator: an idempotent async function that runs the
 * broker's graceful shutdown exactly once and then invokes `exit` with the
 * caller-specified exit code. A fatal condition (e.g. an unrecoverable
 * gateway error) must exit non-zero; a clean signal-triggered shutdown
 * (SIGTERM/SIGINT) exits zero. The exit code is threaded through per-call
 * rather than mutated on a shared `process.exitCode`, so a later, unrelated
 * clean-shutdown call can never silently downgrade a fatal exit back to 0.
 * `exit` is injectable so this can be exercised in tests without ending the
 * test process.
 * @param {{logger: import('./logger.js').Logger, broker: Broker, exit?: (code:number) => void}} opts
 * @returns {(reason: string, exitCode?: number) => Promise<void>}
 */
export function createShutdownCoordinator({ logger, broker, exit = (code) => process.exit(code) }) {
  let shuttingDown = false;
  return async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason, exitCode });
    try {
      await broker.shutdown();
    } catch (err) {
      logger.error('error during shutdown', { error: err.message });
    }
    logger.info('shutdown complete');
    exit(exitCode);
  };
}

async function main() {
  let config;
  try {
    config = loadConfig(resolveRuntimeEnvironment(process.env));
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config);
  logger.info('starting discord-copilot-broker', {
    stateDir: config.stateDir,
    defaultCwd: config.defaultCwd,
    maxSessions: config.maxSessions,
  });

  const stateStore = new StateStore(config.stateDir, logger);
  try {
    await stateStore.load();
  } catch (err) {
    if (err instanceof StateCorruptError) {
      logger.error('state file was corrupt and has been quarantined', {
        quarantinePath: err.quarantinePath,
      });
      process.exit(1);
    }
    throw err;
  }

  const restClient = new DiscordRestClient(config.discordBotToken, logger);
  const gateway = new GatewayClient({ token: config.discordBotToken, logger, stateStore });

  const broker = new Broker({ config, logger, restClient, gateway, stateStore });

  const shutdown = createShutdownCoordinator({ logger, broker });

  gateway.on('fatal', (err) => {
    logger.error('fatal gateway error, exiting', { error: err.message });
    shutdown('fatal-gateway-error', 1);
  });

  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('SIGINT', () => shutdown('SIGINT', 0));

  await broker.start();
}

// Only auto-run when this file is the actual program entry point (not when
// imported by tests to reuse createShutdownCoordinator).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
