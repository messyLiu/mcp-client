import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

for (const signal of (process.platform === 'win32' ? ['SIGINT'] : ['SIGINT', 'SIGHUP']) as NodeJS.Signals[]) {
  test(`server releases its port on ${signal}`, { timeout: 15000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-shutdown-'));
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../server/index.ts', import.meta.url))], {
      cwd: dir, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let output = '';
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`服务启动超时：${output}`)), 5000);
        child.stdout.on('data', chunk => {
          output += chunk;
          const match = output.match(/MCP Workbench → (http:\/\/127\.0\.0\.1:\d+)/);
          if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        child.stderr.on('data', chunk => { output += chunk; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`服务提前退出：${output}`)); });
      });
      assert.equal((await fetch(url + '/api/bootstrap')).status, 200);
      child.kill(signal);
      const [code] = await exited;
      if (process.platform !== 'win32') assert.equal(code, 0, output);
      await assert.rejects(fetch(url + '/api/bootstrap', { signal: AbortSignal.timeout(1000) }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('occupied port reports an error without opening a workbench', { timeout: 10000 }, async () => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-port-conflict-'));
  const port = (occupied.address() as import('node:net').AddressInfo).port;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../server/index.ts', import.meta.url))], {
    cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, output);
    assert.match(output, /端口 .* 已被占用/);
    assert.doesNotMatch(output, /MCP Workbench →|TypeError/);
    assert.ok(occupied.listening, 'the existing service must remain untouched');
  } finally {
    clearTimeout(timer);
    occupied.close();
    await rm(dir, { recursive: true, force: true });
  }
});
