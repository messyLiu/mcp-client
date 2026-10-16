import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpManager } from '../server/mcp.js';
import { TraceStore } from '../server/trace.js';
import { demoProfile } from '../server/profiles.js';
import type { Connection } from '../shared/types.js';

const connection = (id: string): Connection => ({ id, profileId: 'demo', name: 'Demo', status: 'connected' });
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('disconnect rejects reconnect until transport cleanup completes', async () => {
  const manager = new McpManager(new TraceStore());
  const closing = deferred<void>();
  Object.assign(manager, { connection: connection('old'), client: { close: () => closing.promise } });
  const pending = manager.disconnect();
  assert.equal(manager.connection?.status, 'disconnected', 'closing connections must not be reused');
  try {
    await assert.rejects(manager.connect(demoProfile), /连接正在切换/);
  } finally {
    closing.resolve();
    await pending;
  }
  assert.equal(manager.connection?.id, 'old');
});

test('late catalog responses cannot overwrite a replacement connection', async () => {
  const trace = new TraceStore();
  const manager = new McpManager(trace);
  const listing = deferred<{ tools: unknown[] }>();
  Object.assign(manager, {
    connection: connection('old'),
    client: { getServerCapabilities: () => ({ tools: {} }), listTools: () => listing.promise },
  });
  const pending = manager.refreshCatalog();
  const replacementCatalog = { tools: [{ name: 'new-tool', inputSchema: { type: 'object' } }], resources: [], prompts: [] };
  Object.assign(manager, { connection: connection('new'), client: {}, catalog: replacementCatalog });
  let published = false;
  trace.on('session', () => { published = true; });
  listing.resolve({ tools: [{ name: 'old-tool' }] });
  await assert.rejects(pending, /连接已变化/);
  assert.equal(manager.catalog, replacementCatalog);
  assert.equal(published, false);
});
