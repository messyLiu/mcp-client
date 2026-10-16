import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3210);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是 0–65535 之间的整数');
const { app, manager } = await createApp(resolve('.data'), resolve('dist'));
const server = app.listen(port, '127.0.0.1');
server.once('listening', () => {
  const actualPort = (server.address() as import('node:net').AddressInfo).port;
  const url = `http://127.0.0.1:${actualPort}`;
  console.log(`\n  MCP Workbench → ${url}\n  本地演示 MCP → ${url}/demo/mcp\n`);
  if (process.argv.includes('--open')) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(command, [url], { stdio: 'ignore' }).on('error', () => {});
  }
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `启动失败：端口 ${port} 已被占用，请关闭之前的启动窗口，或使用 PORT 指定其他端口。` : `启动失败：${error.message}`);
  process.exitCode = 1;
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(0), 2000); deadline.unref();
  await manager.closeAll();
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
