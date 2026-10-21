#!/usr/bin/env node
/**
 * Mock ACP agent fixture for tests. Speaks NDJSON JSON-RPC 2.0 on
 * stdin/stdout, mimicking just enough of the real Copilot ACP surface to
 * exercise AcpClient: initialize, session/new, session/resume (and a
 * fallback to session/load), session/prompt (streaming session/update
 * notifications then a result), session/cancel, session/close, and a
 * reverse `session/request_permission` request triggered by a special
 * prompt text.
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

let nextReverseId = 1;
const pendingReverse = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Response to a reverse request we sent earlier.
  if ('id' in msg && ('result' in msg || 'error' in msg) && pendingReverse.has(msg.id)) {
    const handler = pendingReverse.get(msg.id);
    pendingReverse.delete(msg.id);
    handler(msg);
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: false },
          loadSession: true,
          sessionCapabilities: { resume: true, close: true },
        },
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-abc123' } });
    return;
  }

  if (msg.method === 'session/resume') {
    if (msg.params?.sessionId === 'unsupported-resume') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    if (msg.params?.sessionId === 'broken-session') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'session not found' } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/load') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }

  if (msg.method === 'session/prompt') {
    const text = msg.params?.prompt?.find((b) => b.type === 'text')?.text || '';
    const sessionId = msg.params.sessionId;

    if (text.includes('__PERMISSION__')) {
      const reverseId = nextReverseId++;
      send({
        jsonrpc: '2.0',
        id: reverseId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { title: 'Run rm -rf', kind: 'execute', rawInput: { command: 'rm -rf /tmp/x' } },
          options: [
            { optionId: 'allow-once-opt', kind: 'allow_once', name: 'Allow' },
            { optionId: 'reject-opt', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      pendingReverse.set(reverseId, (response) => {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission-outcome:${JSON.stringify(response.result)}` } },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      });
      return;
    }

    if (text.includes('__SLOW__')) {
      // Never resolve until cancelled; respond to session/cancel notification separately.
      global.__slowPromptId = msg.id;
      return;
    }

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}` } } },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (msg.method === 'session/cancel') {
    if (global.__slowPromptId) {
      send({ jsonrpc: '2.0', id: global.__slowPromptId, result: { stopReason: 'cancelled' } });
      global.__slowPromptId = null;
    }
    return;
  }

  if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'crash-me') {
    process.exit(1);
  }
});
