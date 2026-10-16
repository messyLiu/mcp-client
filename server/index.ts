import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3210);
const { app, manager } = await createApp(resolve('.data'), resolve('dist'));
const server = app.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  MCP Workbench → ${url}\n  本地演示 MCP → ${url}/demo/mcp\n`);
  if (process.argv.includes('--open')) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(command, [url], { stdio: 'ignore' }).on('error', () => {});
  }
});
server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(0), 2000); deadline.unref();
  await manager.disconnect().catch(() => {});
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
