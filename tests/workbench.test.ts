import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { demoProfile, ProfileStore } from '../server/profiles.js';
import { TraceStore, instrumentFetch } from '../server/trace.js';

test('local workbench end-to-end: modern/legacy, calls, cancel, storage and access controls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-workbench-test-'));
  const { app, manager, trace, profiles } = await createApp(dir, resolve('dist'));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const request = async (path: string, body?: unknown, method = 'POST') => {
    const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': bootstrap.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const config = { ...demoProfile, url: base + '/demo/mcp' };
  try {
    await t.test('reject unauthenticated mutations and external origins', async () => {
      assert.equal((await fetch(base + '/api/disconnect', { method: 'POST' })).status, 403);
      assert.equal((await fetch(base + '/api/bootstrap', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
      assert.equal((await request('/profiles', { ...config, url: 'file:///etc/passwd' })).status, 400);
    });
    await t.test('modern discovery loads advertised tools/resources/prompts', async () => {
      assert.equal((await request('/profiles', config)).status, 200);
      const response = await request('/connect', { profileId: 'demo' });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.connection.protocol, '2026-07-28');
      assert.deepEqual(response.data.catalog.tools.map((x: {name: string}) => x.name).sort(), ['calculate', 'echo', 'wait']);
      assert.equal(response.data.catalog.resources.length, 1);
      assert.equal(response.data.catalog.prompts.length, 1);
    });
    await t.test('config preview is read-only; import saves normalized profiles without persisting secrets', async () => {
      const config = JSON.stringify({ mcpServers: { imported: { type: 'streamable_http', url: base + '/demo/mcp', headers: { Authorization: 'Bearer import-test-secret', 'X-Tenant': 'tenant-secret' } } } });
      const before = profiles.profiles.length;
      const preview = await request('/profiles/import', { config, preview: true });
      assert.equal(preview.status, 200);
      assert.equal(profiles.profiles.length, before);
      assert.equal(preview.data.profiles[0].hasSecret, true);
      assert.ok(!JSON.stringify(preview.data).includes('import-test-secret'));
      assert.ok(!JSON.stringify(preview.data).includes('tenant-secret'));
      const saved = await request('/profiles/import', { config, preview: false });
      assert.equal(saved.status, 200);
      assert.equal(profiles.profiles.length, before + 1);
      assert.equal(profiles.secret(saved.data.profiles[0].id), 'import-test-secret');
      assert.equal(manager.connection?.profileId, 'demo');
      const stored = await readFile(join(dir, 'profiles.json'), 'utf8');
      assert.ok(!stored.includes('import-test-secret') && !stored.includes('tenant-secret'));
    });
    await t.test('echo response and raw protocol events correlate', async () => {
      const response = await request('/calls', { callId: randomUUID(), method: 'tools/call', name: 'echo', arguments: { message: 'Hello MCP!', uppercase: true } });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.result.content[0].text, 'HELLO MCP!');
      const outgoing = [...trace.events].reverse().find(e => e.layer === 'rpc' && e.direction === 'out' && e.method === 'tools/call');
      const incoming = [...trace.events].reverse().find(e => e.layer === 'rpc' && e.direction === 'in' && e.rpcId === outgoing?.rpcId);
      assert.ok(outgoing && incoming);
      assert.ok(incoming.durationMs! >= 0);
      assert.ok(trace.events.some(e => e.layer === 'http' && e.kind === 'request'));
      assert.ok(trace.events.some(e => e.layer === 'http' && ['body', 'sse-frame'].includes(e.kind)));
    });
    await t.test('tool errors, resource reads and prompt arguments', async () => {
      const fail = await request('/calls', { callId: randomUUID(), method: 'tools/call', name: 'calculate', arguments: { operation: 'divide', a: 1, b: 0 } });
      assert.equal(fail.data.result.isError, true);
      const resource = await request('/calls', { callId: randomUUID(), method: 'resources/read', name: 'demo://welcome', arguments: {} });
      assert.match(resource.data.result.contents[0].text, /MCP Workbench/);
      const prompt = await request('/calls', { callId: randomUUID(), method: 'prompts/get', name: 'summarize', arguments: { text: 'Example' } });
      assert.match(prompt.data.result.messages[0].content.text, /Example/);
      assert.equal((await request('/calls', { callId: randomUUID(), method: 'prompts/get', name: 'summarize', arguments: { text: 123 } })).status, 400);
    });
    await t.test('cancel an in-flight request', async () => {
      const id = randomUUID();
      const started = new Promise<void>(resolve => {
        const listener = (event: {method?: string; direction: string}) => { if (event.method === 'tools/call' && event.direction === 'out') { trace.off('trace', listener); resolve(); } };
        trace.on('trace', listener);
      });
      const pending = request('/calls', { callId: id, method: 'tools/call', name: 'wait', arguments: { seconds: 5 } });
      await started;
      assert.equal((await request(`/calls/${id}/cancel`, {})).data.cancelled, true);
      const response = await pending;
      assert.equal(response.status, 500);
      assert.ok(trace.events.some(e => e.kind === 'call-error'));
    });
    await t.test('legacy handshake, timeout, and credentials stay out of stored profiles and traces', async () => {
      await request('/profiles', { ...config, protocol: 'legacy', timeoutMs: 1000, auth: 'bearer', apiKey: 'workbench-test-secret', headers: [{ name: 'X-Custom-Key', value: 'header-test-secret' }] });
      const connection = await request('/connect', { profileId: 'demo' });
      assert.equal(connection.status, 200, JSON.stringify(connection.data));
      assert.equal(connection.data.connection.protocol, '2025-11-25');
      const response = await request('/calls', { callId: randomUUID(), method: 'tools/call', name: 'wait', arguments: { seconds: 2 } });
      assert.equal(response.status, 500);
      const saved = await readFile(join(dir, 'profiles.json'), 'utf8');
      assert.ok(!saved.includes('workbench-test-secret') && !saved.includes('header-test-secret'));
      const exported = await (await fetch(base + '/api/events/export')).text();
      assert.ok(!exported.includes('workbench-test-secret') && !exported.includes('header-test-secret'));
      assert.ok(exported.includes('[REDACTED]'));
      const fresh = new ProfileStore(join(dir, 'profiles.json')); await fresh.load();
      assert.equal(fresh.get('demo')!.hasSecret, false);
      assert.equal(fresh.get('demo')!.headers[0].value, '');
      assert.equal(profiles.get('demo')!.hasSecret, true);
    });
    await t.test('disconnect closes the active client and clear removes events', async () => {
      assert.equal((await request('/disconnect', {})).status, 200);
      assert.equal(manager.connection?.status, 'disconnected');
      assert.equal((await request('/events', undefined, 'DELETE')).status, 200);
      assert.equal(trace.events.length, 0);
    });
  } finally {
    await manager.disconnect();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP observation preserves streaming bytes, captures split SSE frames and redacts data', async () => {
  const store = new TraceStore(3); store.secrets.add('top-secret');
  const pieces = ['event: message\r\ndata: {"token":"top-', 'secret"}\r\n', '\r\nevent: message\ndata: {"result":42}\n\n'];
  const original = pieces.join('');
  const fakeFetch: typeof fetch = async (_input, options) => {
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer top-secret');
    return new Response(new ReadableStream({ start(controller) { for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const response = await instrumentFetch(store, 'test', { authorization: 'Bearer top-secret' }, fakeFetch)('http://localhost/mcp', { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}' });
  assert.equal(await response.text(), original);
  assert.equal(store.events.filter(e => e.kind === 'sse-frame').length, 2);
  assert.ok(!JSON.stringify(store.events).includes('top-secret'));
  assert.equal(store.events.length, 3);
  assert.ok(JSON.stringify(store.events).includes('[REDACTED]'));
  await assert.rejects(() => instrumentFetch(store, 'test', {}, fakeFetch, 'https://trusted.example')('https://other.example/mcp'), /另一来源/);
});
