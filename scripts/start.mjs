import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const windows = process.platform === 'win32';
let child;
let interrupted = false;

// npm/build may spawn descendants. Stop only the process tree we started.
function stopPreparation() {
  if (interrupted) return;
  interrupted = true;
  if (!child?.pid) { process.exit(0); return; }
  if (windows) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('error', () => process.exit(1));
    killer.on('close', () => process.exit(0));
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ }
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
      process.exit(0);
    }, 1500);
  }
}
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) process.on(signal, stopPreparation);

function npm(args) {
  // Arguments are fixed by this script; never interpolate user input into cmd.exe.
  return new Promise((resolve, reject) => {
    child = windows
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], { stdio: 'inherit' })
      : spawn('npm', args, { stdio: 'inherit', detached: true });
    child.once('error', error => reject(new Error(`无法运行 npm，请检查 Node.js/npm 安装：${error.message}`)));
    child.once('close', code => {
      if (interrupted) return;
      child = undefined;
      if (code === 0) resolve(); else reject(new Error(`npm ${args.join(' ')} 失败（退出码 ${code}），请查看上方输出后重试。`));
    });
  });
}

// Keep a double-clicked terminal open on failure so the error remains readable.
process.once('beforeExit', async code => {
  if (!code || interrupted || !process.stdin.isTTY) return;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { await input.question('\n启动失败，按回车关闭…'); } finally { input.close(); }
});

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error(`当前 Node.js ${process.versions.node} 不受支持，请安装 Node.js 22.12 或更新版本。`);
  const unknown = process.argv.slice(2).filter(arg => arg !== '--no-open');
  if (unknown.length) throw new Error(`不支持的参数：${unknown.join(' ')}。可用参数：--no-open（不自动打开浏览器）。`);

  console.log('\nMCP Workbench 启动器\n关闭此终端窗口或按 Ctrl+C 可停止服务。\n');
  const fingerprint = createHash('sha256')
    .update(await readFile('package-lock.json'))
    .update(await readFile('package.json'))
    .update(`${process.platform}:${process.arch}:${major}`)
    .digest('hex');
  const stamp = 'node_modules/.mcp-workbench-install';
  let installed = false;
  try {
    installed = (await readFile(stamp, 'utf8')) === fingerprint;
    for (const path of ['tsx/package.json', 'typescript/bin/tsc', 'vite/bin/vite.js', 'express/package.json']) await access(`node_modules/${path}`);
  } catch { installed = false; }
  if (!installed) {
    console.log('[1/3] 安装项目依赖（首次运行或依赖变更时需要联网）…');
    await npm(['ci', '--include=dev', '--no-audit', '--no-fund']);
    await writeFile(stamp, fingerprint);
  } else console.log('[1/3] 依赖已就绪。');

  console.log('[2/3] 检查并构建工作台…');
  await npm(['run', 'build']);
  console.log('[3/3] 启动本地服务…');
  for (const signal of signals) process.removeListener(signal, stopPreparation);
  if (!process.argv.includes('--no-open')) process.argv.push('--open');
  // Load the server in this process: no background service survives this launcher.
  const { register } = await import('tsx/esm/api');
  register();
  await import('../server/index.ts');
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
