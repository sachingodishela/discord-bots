#!/usr/bin/env node
import { AcpClient } from '../src/acp/client.js';
import { createLogger } from '../src/logger.js';

const copilotBin = process.env.COPILOT_BIN || '/usr/local/bin/copilot';
const cwd = process.env.BROKER_DEFAULT_CWD || '/workspace';
const logger = createLogger({ logLevel: 'error' });

const client = new AcpClient({ copilotBin, cwd, logger }).start();
let sessionId;

try {
  const initialized = await client.initialize();
  sessionId = await client.sessionNew(cwd);

  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: initialized.protocolVersion,
      agent: initialized.agentInfo?.name,
      agentVersion: initialized.agentInfo?.version,
      loadSession: initialized.agentCapabilities?.loadSession === true,
      resume: !!initialized.agentCapabilities?.sessionCapabilities?.resume,
      close: !!initialized.agentCapabilities?.sessionCapabilities?.close,
      images: client.supportsImages(),
      sessionCreated: typeof sessionId === 'string' && sessionId.length > 0,
    })}\n`,
  );

  await client.sessionClose(sessionId);
} finally {
  client.close();
}
