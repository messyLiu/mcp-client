import express from 'express';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { z } from 'zod';
import { ProfileStore } from './profiles.js';
import { TraceStore } from './trace.js';
import { McpManager } from './mcp.js';
import { createDemoHandler } from './demo.js';

import { profileSchema } from './config.js';
import { parseMcpConfig } from './import-config.js';

export async function createApp(dataDir: string, distDir: string) {
  const app = express();
  const profiles = new ProfileStore(join(dataDir, 'profiles.json'));
  await profiles.load();
  const trace = new TraceStore();
  const manager = new McpManager(trace);
  const csrf = randomUUID();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host ?? '')) { res.status(403).json({ error: '仅允许本机访问' }); return; }
    const origin = req.headers.origin;
    if (origin) {
      try {
        const source = new URL(origin);
        if (!['http:', 'https:'].includes(source.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname)) throw new Error();
      } catch { res.status(403).json({ error: '页面来源不被允许' }); return; }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') { res.status(403).json({ error: '拒绝跨站请求' }); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const demo = createDemoHandler();
  app.all('/demo/mcp', async (req, res, next) => {
    try {
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const request = new Request(`http://${req.headers.host}${req.originalUrl}`, {
        method: req.method, headers: req.headers as Record<string, string>,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body), signal: controller.signal,
      });
      const response = await demo.fetch(request);
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      if (response.body) Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).on('error', next).pipe(res); else res.end();
    } catch (error) { next(error); }
  });

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-workbench-token'] !== csrf) { res.status(403).json({ error: '页面会话已过期，请刷新后重试' }); return; }
    next();
  });
  app.get('/api/bootstrap', (_req, res) => res.json({ token: csrf, profiles: profiles.profiles, connection: manager.connection, catalog: manager.catalog }));
  app.post('/api/profiles/import', async (req, res) => {
    const { config, preview } = z.object({ config: z.string().min(1).max(256 * 1024), preview: z.boolean().default(true) }).parse(req.body);
    let parsed: ReturnType<typeof parseMcpConfig>;
    try { parsed = parseMcpConfig(config, profiles.profiles.map(p => p.name)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); return; }
    if (profiles.profiles.length + parsed.inputs.length > 50) { res.status(400).json({ error: '导入后将超过 50 个连接的上限，请先删除不需要的配置' }); return; }
    if (preview) {
      res.json({ profiles: parsed.inputs.map(({ apiKey, ...profile }) => ({ ...profile, headers: profile.headers.map(h => ({ name: h.name, value: '' })), hasSecret: Boolean(apiKey) })), issues: parsed.issues });
      return;
    }
    if (!parsed.inputs.length) { res.status(400).json({ error: parsed.issues.join('；') || '没有可导入的连接' }); return; }
    const saved = [];
    for (const profile of parsed.inputs) saved.push(await profiles.save(profile));
    res.json({ profiles: saved, issues: parsed.issues });
  });
  app.post('/api/profiles', async (req, res) => {
    const input = profileSchema.parse(req.body);
    if (!profiles.get(input.id) && profiles.profiles.length >= 50) { res.status(400).json({ error: '最多保存 50 个连接' }); return; }
    const names = input.headers.map(h => h.name.toLowerCase());
    if (new Set(names).size !== names.length) { res.status(400).json({ error: '请求头名称不能重复' }); return; }
    res.json(await profiles.save(input));
  });
  app.delete('/api/profiles/:id', async (req, res) => {
    if (manager.connection?.profileId === req.params.id) await manager.disconnect();
    await profiles.remove(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/connect', async (req, res) => {
    const { profileId } = z.object({ profileId: z.string() }).parse(req.body);
    const profile = profiles.get(profileId);
    if (!profile) { res.status(404).json({ error: '连接配置不存在' }); return; }
    res.json(await manager.connect(profile, profiles.secret(profile.id)));
  });
  app.post('/api/disconnect', async (_req, res) => { await manager.disconnect(); res.json({ ok: true }); });
  app.post('/api/catalog/refresh', async (_req, res) => res.json(await manager.refreshCatalog()));
  app.post('/api/calls', async (req, res) => {
    const input = z.object({ callId: z.string().uuid(), method: z.enum(['tools/call', 'resources/read', 'prompts/get']), name: z.string().min(1).max(4096), arguments: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
    if (input.method === 'prompts/get' && Object.values(input.arguments).some(v => typeof v !== 'string')) { res.status(400).json({ error: 'Prompt 参数必须是字符串' }); return; }
    res.json(await manager.call(input.callId, input.method, input.name, input.arguments));
  });
  app.post('/api/calls/:id/cancel', (req, res) => res.json({ cancelled: manager.cancel(req.params.id) }));
  app.delete('/api/events', (_req, res) => { trace.clear(); res.json({ ok: true }); });
  app.get('/api/events/export', (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="mcp-trace.json"');
    res.json({ exportedAt: new Date().toISOString(), redacted: true, retentionLimit: trace.limit, events: trace.events });
  });
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
      if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('snapshot', { events: trace.events, connection: manager.connection });
    const onTrace = (event: unknown) => send('trace', event);
    const onConnection = (connection: unknown) => send('connection', connection);
    const onCatalog = (catalog: unknown) => send('catalog', catalog);
    const onClear = () => send('clear', {});
    trace.on('trace', onTrace); trace.on('connection', onConnection); trace.on('catalog', onCatalog); trace.on('clear', onClear);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => { clearInterval(heartbeat); trace.off('trace', onTrace); trace.off('connection', onConnection); trace.off('catalog', onCatalog); trace.off('clear', onClear); });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use(express.static(distDir));
  app.get('/', (_req, res) => res.status(503).send('请先运行 npm run build，再运行 npm start。开发模式请打开 Vite 显示的地址。'));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error instanceof Error ? error.message : String(error);
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: trace.redact(message) });
  });
  return { app, manager, trace, profiles };
}
