import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

async function fixture(mode: 'fail' | 'wait') {
  const dir = await mkdtemp(join(tmpdir(), 'mcp launcher review-'));
  await mkdir(join(dir, 'scripts'));
  await mkdir(join(dir, 'bin'));
  await copyFile(new URL('../scripts/start.mjs', import.meta.url), join(dir, 'scripts/start.mjs'));
  await writeFile(join(dir, 'package.json'), '{}');
  await writeFile(join(dir, 'package-lock.json'), '{}');
  await writeFile(join(dir, 'bin/npm'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('npm-calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
if (${JSON.stringify(mode)} === 'fail') process.exit(7);
const child = require('node:child_process').spawn(process.execPath, ['-e',
  "process.on('SIGTERM', () => {}); console.log('CHILD_READY'); setInterval(() => {}, 1000);"
], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.once('data', () => console.log('NPM_READY ' + process.pid + ' ' + child.pid));
`, { mode: 0o755 });
  const child = spawn(process.execPath, [join(dir, 'scripts/start.mjs'), '--no-open'], {
    cwd: tmpdir(),
    env: { ...process.env, PATH: [join(dir, 'bin'), dirname(process.execPath), process.env.PATH].join(delimiter) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let output = '';
  let npmPid: number | undefined;
  child.stdout.on('data', chunk => {
    output += chunk;
    const match = output.match(/NPM_READY (\d+)/);
    if (match) npmPid = Number(match[1]);
  });
  child.stderr.on('data', chunk => { output += chunk; });
  const terminate = () => {
    if (npmPid) { try { process.kill(-npmPid, 'SIGKILL'); } catch { /* already gone */ } }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const timer = setTimeout(terminate, 8000);
  return {
    dir, child, closed, output: () => output,
    async cleanup() { clearTimeout(timer); terminate(); await closed; await rm(dir, { recursive: true, force: true }); },
  };
}

test('failed dependency installation never builds or starts the service', { skip: process.platform === 'win32', timeout: 12000 }, async () => {
  const run = await fixture('fail');
  try {
    assert.equal((await run.closed)[0], 1, run.output());
    assert.match(run.output(), /退出码 7/);
    assert.doesNotMatch(run.output(), /启动本地服务|MCP Workbench →/);
    const calls = (await readFile(join(run.dir, 'npm-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls, [['ci', '--include=dev', '--no-audit', '--no-fund']]);
  } finally { await run.cleanup(); }
});

test('interrupting installation also terminates npm descendants', { skip: process.platform === 'win32', timeout: 12000 }, async () => {
  const run = await fixture('wait');
  try {
    await new Promise<void>((resolve, reject) => {
      run.child.stdout.on('data', () => { if (/NPM_READY/.test(run.output())) resolve(); });
      run.child.once('close', () => reject(new Error(run.output())));
    });
    run.child.kill('SIGHUP');
    // close waits for inherited pipes too, including the child that ignores SIGTERM.
    assert.equal((await run.closed)[0], 0, run.output());
    assert.doesNotMatch(run.output(), /启动本地服务|MCP Workbench →/);
  } finally { await run.cleanup(); }
});
