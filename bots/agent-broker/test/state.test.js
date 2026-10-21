import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, StateCorruptError } from '../src/state/store.js';

// Keep all scratch directories inside the project (never under /tmp).
const TEST_SCRATCH_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '.scratch');

async function withTempDir(fn) {
  await mkdir(TEST_SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_SCRATCH_ROOT, 'broker-state-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('StateStore', () => {
  test('load() on missing file initializes empty state and creates dir with 0700', async () => {
    await withTempDir(async (base) => {
      const dir = path.join(base, 'state');
      const store = new StateStore(dir);
      const data = await store.load();
      assert.deepEqual(data.threads, {});
      assert.equal(data.gateway, null);
      const st = await stat(dir);
      assert.equal(st.mode & 0o777, 0o700);
    });
  });

  test('save() writes atomically with 0600 permissions and round-trips', async () => {
    await withTempDir(async (base) => {
      const dir = path.join(base, 'state');
      const store = new StateStore(dir);
      await store.load();
      const now = new Date().toISOString();
      store.setThread('123456789012345678', {
        copilotSessionId: 'sess-1',
        cwd: '/home/sachin',
        createdAt: now,
        updatedAt: now,
      });
      store.setGateway({ sessionId: 'gw-1', seq: 42, resumeGatewayUrl: 'wss://example' });
      await store.save();

      const filePath = path.join(dir, 'state.json');
      const st = await stat(filePath);
      assert.equal(st.mode & 0o777, 0o600);

      const store2 = new StateStore(dir);
      const data = await store2.load();
      assert.equal(data.threads['123456789012345678'].copilotSessionId, 'sess-1');
      assert.equal(data.gateway.seq, 42);
    });
  });

  test('never persists prompts or approval nonces (only whitelisted thread fields)', async () => {
    await withTempDir(async (base) => {
      const dir = path.join(base, 'state');
      const store = new StateStore(dir);
      await store.load();
      store.setThread('thread-1', {
        copilotSessionId: 'sess-1',
        cwd: '/home/sachin',
        createdAt: 'x',
        updatedAt: 'y',
      });
      await store.save();
      const raw = await readFile(path.join(dir, 'state.json'), 'utf8');
      assert.ok(!raw.includes('prompt'));
      assert.ok(!raw.includes('nonce'));
    });
  });

  test('corrupt JSON is quarantined and throws StateCorruptError (no silent reset)', async () => {
    await withTempDir(async (base) => {
      const dir = path.join(base, 'state');
      await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true, mode: 0o700 }));
      await writeFile(path.join(dir, 'state.json'), '{ this is not json', { mode: 0o600 });

      const store = new StateStore(dir);
      await assert.rejects(() => store.load(), StateCorruptError);

      // Original file should be gone (renamed aside), quarantine file should exist.
      const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
      assert.ok(!files.includes('state.json'));
      assert.ok(files.some((f) => f.startsWith('state.json.corrupt-')));
    });
  });

  test('invalid shape (valid JSON, wrong structure) is quarantined', async () => {
    await withTempDir(async (base) => {
      const dir = path.join(base, 'state');
      await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true, mode: 0o700 }));
      await writeFile(path.join(dir, 'state.json'), JSON.stringify({ foo: 'bar' }), { mode: 0o600 });

      const store = new StateStore(dir);
      await assert.rejects(() => store.load(), StateCorruptError);
    });
  });

  test('deleteThread removes mapping', async () => {
    await withTempDir(async (base) => {
      const dir = path.join(base, 'state');
      const store = new StateStore(dir);
      await store.load();
      store.setThread('t1', { copilotSessionId: null, cwd: '/home/sachin', createdAt: '', updatedAt: '' });
      assert.ok(store.getThread('t1'));
      store.deleteThread('t1');
      assert.equal(store.getThread('t1'), undefined);
    });
  });

  describe('strict schema validation on load()', () => {
    const validThread = () => ({
      copilotSessionId: 'sess-1',
      cwd: '/home/sachin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    async function writeAndExpectQuarantine(base, doc) {
      const dir = path.join(base, 'state');
      await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true, mode: 0o700 }));
      await writeFile(path.join(dir, 'state.json'), JSON.stringify(doc), { mode: 0o600 });
      const store = new StateStore(dir);
      await assert.rejects(() => store.load(), StateCorruptError);
      const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
      assert.ok(files.some((f) => f.startsWith('state.json.corrupt-')));
    }

    test('rejects a mismatched version number', async () => {
      await withTempDir(async (base) => {
        await writeAndExpectQuarantine(base, { version: 999, gateway: null, threads: {} });
      });
    });

    test('rejects a non-snowflake thread ID', async () => {
      await withTempDir(async (base) => {
        await writeAndExpectQuarantine(base, {
          version: 1,
          gateway: null,
          threads: { 'thread-1': validThread() },
        });
      });
    });

    test('rejects a thread with an extra/arbitrary field', async () => {
      await withTempDir(async (base) => {
        await writeAndExpectQuarantine(base, {
          version: 1,
          gateway: null,
          threads: { '123456789012345678': { ...validThread(), pendingPromptText: 'do not persist this' } },
        });
      });
    });

    test('rejects a thread with a relative (non-absolute) cwd', async () => {
      await withTempDir(async (base) => {
        await writeAndExpectQuarantine(base, {
          version: 1,
          gateway: null,
          threads: { '123456789012345678': { ...validThread(), cwd: 'relative/path' } },
        });
      });
    });

    test('rejects a thread with a non-ISO timestamp', async () => {
      await withTempDir(async (base) => {
        await writeAndExpectQuarantine(base, {
          version: 1,
          gateway: null,
          threads: { '123456789012345678': { ...validThread(), createdAt: 'not-a-timestamp' } },
        });
      });
    });

    test('rejects a gateway object with an extra field', async () => {
      await withTempDir(async (base) => {
        await writeAndExpectQuarantine(base, {
          version: 1,
          gateway: { sessionId: 'gw-1', seq: 1, resumeGatewayUrl: null, extra: 'nope' },
          threads: {},
        });
      });
    });

    test('rejects a gateway object with a wrong-typed field', async () => {
      await withTempDir(async (base) => {
        await writeAndExpectQuarantine(base, {
          version: 1,
          gateway: { sessionId: 'gw-1', seq: 'not-a-number', resumeGatewayUrl: null },
          threads: {},
        });
      });
    });

    test('accepts a fully valid document with a null gateway and a valid snowflake thread', async () => {
      await withTempDir(async (base) => {
        const dir = path.join(base, 'state');
        await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true, mode: 0o700 }));
        const doc = { version: 1, gateway: null, threads: { '123456789012345678': validThread() } };
        await writeFile(path.join(dir, 'state.json'), JSON.stringify(doc), { mode: 0o600 });
        const store = new StateStore(dir);
        const data = await store.load();
        assert.equal(data.threads['123456789012345678'].copilotSessionId, 'sess-1');
      });
    });
  });

  describe('concurrent save() serialization', () => {
    test('a slower earlier save cannot overwrite a faster later save', async () => {
      await withTempDir(async (base) => {
        const dir = path.join(base, 'state');
        let renameCount = 0;
        const store = new StateStore(dir, undefined, {
          rename: async (from, to) => {
            renameCount += 1;
            // Artificially delay only the *first* rename (the older save's),
            // so that without serialization it would land after the second.
            if (renameCount === 1) await new Promise((r) => setTimeout(r, 40));
            const { rename } = await import('node:fs/promises');
            return rename(from, to);
          },
        });
        await store.load();

        store.setThread('123456789012345678', {
          copilotSessionId: 'first',
          cwd: '/home/sachin',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const saveA = store.save(); // older, artificially slow rename

        store.setThread('123456789012345678', {
          copilotSessionId: 'second',
          cwd: '/home/sachin',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const saveB = store.save(); // newer save, called while A is still in flight

        await Promise.all([saveA, saveB]);

        const reloaded = new StateStore(dir);
        const data = await reloaded.load();
        assert.equal(
          data.threads['123456789012345678'].copilotSessionId,
          'second',
          'the final on-disk state must reflect the newer save, not have been clobbered by the slower older one',
        );
        assert.equal(renameCount, 2);
      });
    });

    test('a failing save does not permanently break the serialization queue for later saves', async () => {
      await withTempDir(async (base) => {
        const dir = path.join(base, 'state');
        let attempt = 0;
        const store = new StateStore(dir, undefined, {
          rename: async (from, to) => {
            attempt += 1;
            if (attempt === 1) throw new Error('simulated rename failure');
            const { rename } = await import('node:fs/promises');
            return rename(from, to);
          },
        });
        await store.load();

        store.setThread('123456789012345678', {
          copilotSessionId: 'will-fail',
          cwd: '/home/sachin',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await assert.rejects(() => store.save());

        store.setThread('123456789012345678', {
          copilotSessionId: 'will-succeed',
          cwd: '/home/sachin',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await store.save();

        const reloaded = new StateStore(dir);
        const data = await reloaded.load();
        assert.equal(data.threads['123456789012345678'].copilotSessionId, 'will-succeed');
      });
    });
  });
});
