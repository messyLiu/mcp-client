import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpConfig } from '../server/import-config.js';

const example = { mcpServers: { '12306-mcp': { type: 'streamable_http', url: 'https://example.com/mcp' } } };

test('recognize the supplied ModelScope configuration', () => {
  const result = parseMcpConfig(JSON.stringify(example));
  assert.equal(result.issues.length, 0);
  assert.equal(result.inputs.length, 1);
  assert.equal(result.inputs[0].name, '12306-mcp');
  assert.equal(result.inputs[0].url, example.mcpServers['12306-mcp'].url);
  assert.equal(result.inputs[0].transport, 'http');
  assert.equal(result.inputs[0].auth, 'none');
  assert.equal(result.inputs[0].timeoutMs, 30000);
});

test('detect common transports and credentials, preserve custom headers, rename duplicates', () => {
  const result = parseMcpConfig(JSON.stringify({ mcpServers: {
    bearer: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer demo-token', 'X-Tenant-ID': 'dev' } },
    keyed: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'x-api-key': 'demo-key' } },
    old: { type: 'sse', url: 'http://localhost:8888/sse' },
  } }), ['bearer', 'bearer (2)']);
  assert.equal(result.issues.length, 0);
  assert.equal(result.inputs[0].name, 'bearer (3)');
  assert.equal(result.inputs[0].auth, 'bearer');
  assert.equal(result.inputs[0].apiKey, 'demo-token');
  assert.deepEqual(result.inputs[0].headers, [{ name: 'X-Tenant-ID', value: 'dev' }]);
  assert.equal(result.inputs[1].auth, 'header');
  assert.equal(result.inputs[1].authHeader, 'x-api-key');
  assert.equal(result.inputs[2].transport, 'sse');
});

test('report unsupported or malformed entries without importing them', () => {
  assert.throws(() => parseMcpConfig('{'), /JSON 格式/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{}}'), /未找到/);
  const result = parseMcpConfig(JSON.stringify({ mcpServers: {
    good: { url: 'https://example.com/mcp' },
    stdio: { command: 'npx', args: ['anything'] },
    disabled: { disabled: true, url: 'https://example.com/mcp' },
    invalidUrl: { url: 'file:///private/file' },
    invalidHeader: { url: 'https://example.com/mcp', headers: { test: 42 } },
    duplicateHeader: { url: 'https://example.com/mcp', headers: { 'X-Test': 'one', 'x-test': 'two' } },
  } }));
  assert.equal(result.inputs.length, 1);
  assert.equal(result.issues.length, 5);
  assert.match(result.issues[0], /stdio/);
});

test('single service config supports API key and explicit timeout', () => {
  const result = parseMcpConfig(JSON.stringify({ name: 'single', url: 'https://example.com/mcp', apiKey: 'key-value', authHeader: 'X-Service-Key', timeoutMs: 45000 }));
  assert.equal(result.inputs[0].auth, 'header');
  assert.equal(result.inputs[0].apiKey, 'key-value');
  assert.equal(result.inputs[0].timeoutMs, 45000);
});
