import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, SSEClientTransport, type Transport, type JSONRPCMessage } from '@modelcontextprotocol/client';
import type { Catalog, Connection, Profile } from '../shared/types.js';
import { TraceStore, instrumentFetch } from './trace.js';

const traceContext = (connection: Connection) => ({ connectionId: connection.id, profileId: connection.profileId, connectionName: connection.name });

function observeTransport(transport: Transport, store: TraceStore, connection: Connection): Transport {
  const pending = new Map<string, { time: number; method: string }>();
  const record = (message: JSONRPCMessage, direction: 'in' | 'out') => {
    const id = 'id' in message ? message.id : undefined;
    let method = 'method' in message ? message.method : undefined;
    let durationMs: number | undefined;
    const key = `${direction === 'out' ? 'in' : 'out'}:${String(id)}`;
    if (method && id !== undefined) {
      pending.set(`${direction}:${String(id)}`, { time: performance.now(), method });
      if (pending.size > 1000) pending.delete(pending.keys().next().value!);
    }
    else if (id !== undefined && pending.has(key)) {
      const request = pending.get(key)!;
      durationMs = performance.now() - request.time;
      method = request.method;
      pending.delete(key);
    }
    store.add({ ...traceContext(connection), layer: 'rpc', direction, kind: 'error' in message ? 'error' : 'method' in message ? (id === undefined ? 'notification' : 'request') : 'response', method, rpcId: id, durationMs, data: message });
  };
  // Preserve the concrete transport's extra negotiation/streaming methods.
  return new Proxy(transport, {
    get(target, prop) {
      if (prop === 'send') return async (...args: Parameters<Transport['send']>) => { record(args[0], 'out'); return target.send(...args); };
      if (prop === 'setProtocolVersion') return (version: string) => { connection.protocol = version; target.setProtocolVersion?.(version); };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' && prop !== 'constructor' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      if (prop === 'onmessage' && value) {
        target.onmessage = (message, extra) => { record(message, 'in'); value(message, extra); };
        return true;
      }
      return Reflect.set(target, prop, value, target);
    },
  });
}

export class McpManager {
  connection: Connection | null = null;
  catalog: Catalog = { tools: [], resources: [], prompts: [] };
  private client?: Client;
  private transport?: StreamableHTTPClientTransport | SSEClientTransport;
  private timeoutMs = 30000;
  private changing = false;
  private calls = new Map<string, AbortController>();
  constructor(readonly trace: TraceStore) {}
  private publish() { if (this.connection) this.trace.emit('session', { connection: this.connection, catalog: this.catalog }); }

  async connect(profile: Profile, apiKey?: string) {
    if (this.changing) throw new Error('连接正在切换，请稍候');
    this.changing = true;
    try {
      await this.close();
      const connection: Connection = { id: randomUUID(), profileId: profile.id, name: profile.name, status: 'connecting' };
      this.connection = connection;
      this.catalog = { tools: [], resources: [], prompts: [] };
      this.publish();
      if (profile.auth !== 'none' && !apiKey) throw new Error('请填写 API Key；密钥仅在本次运行中保留');
      const headers: Record<string, string> = {};
      for (const h of profile.headers) {
        if (h.name && !h.value) throw new Error(`请填写请求头 ${h.name} 的值；请求头值仅在本次运行中保留`);
        if (h.name) { headers[h.name.toLowerCase()] = h.value; this.trace.secrets.add(h.value); }
      }
      if (apiKey) this.trace.secrets.add(apiKey);
      if (profile.auth === 'bearer') headers.authorization = `Bearer ${apiKey}`;
      if (profile.auth === 'header') headers[profile.authHeader.toLowerCase()] = apiKey!;
      this.timeoutMs = profile.timeoutMs;
      const client = new Client({ name: 'mcp-workbench', version: '0.1.0' }, {
        versionNegotiation: { mode: profile.protocol === 'modern' ? { pin: '2026-07-28' } : profile.protocol },
        capabilities: {},
      });
      this.client = client;
      const observedFetch = instrumentFetch(this.trace, connection.id, headers, fetch, new URL(profile.url).origin, traceContext(connection));
      const options = { fetch: observedFetch, requestInit: { headers, redirect: 'error' as const } };
      const transport = profile.transport === 'sse' ? new SSEClientTransport(new URL(profile.url), options) : new StreamableHTTPClientTransport(new URL(profile.url), options);
      this.transport = transport;
      client.onerror = error => this.trace.add({ ...traceContext(connection), layer: 'system', direction: 'internal', kind: 'error', data: { error: error.message } });
      client.onclose = () => {
        if (this.connection === connection && connection.status === 'connected') {
          connection.status = 'disconnected';
          this.catalog = { tools: [], resources: [], prompts: [] };
          this.publish();
        }
      };
      await client.connect(observeTransport(transport, this.trace, connection), { timeout: profile.timeoutMs, signal: AbortSignal.timeout(profile.timeoutMs) });
      const server = client.getServerVersion();
      Object.assign(connection, { status: 'connected', serverName: server?.name, serverVersion: server?.version, capabilities: client.getServerCapabilities() });
      await this.refreshCatalog();
      this.publish();
      return { connection, catalog: this.catalog };
    } catch (error) {
      await this.close();
      if (this.connection) { this.connection.status = 'error'; this.connection.error = String(this.trace.redact(error instanceof Error ? error.message : String(error))); this.publish(); }
      throw error;
    } finally { this.changing = false; }
  }

  async refreshCatalog() {
    const client = this.requireClient();
    const capabilities = client.getServerCapabilities() ?? {};
    const options = { timeout: this.timeoutMs, signal: AbortSignal.timeout(this.timeoutMs), cache: 'reload' as const };
    const [tools, resources, prompts] = await Promise.all([
      capabilities.tools ? client.listTools(undefined, options) : { tools: [] },
      capabilities.resources ? client.listResources(undefined, options) : { resources: [] },
      capabilities.prompts ? client.listPrompts(undefined, options) : { prompts: [] },
    ]);
    if (this.client !== client || this.connection?.status !== 'connected') throw new Error('连接已变化，请重新加载能力列表');
    this.catalog = { tools: tools.tools, resources: resources.resources, prompts: prompts.prompts } as Catalog;
    this.publish();
    return this.catalog;
  }

  private requireClient() {
    if (!this.client || this.connection?.status !== 'connected') throw new Error('请先连接 MCP 服务');
    return this.client;
  }

  async call(callId: string, method: 'tools/call' | 'resources/read' | 'prompts/get', name: string, args: Record<string, unknown>) {
    const client = this.requireClient();
    const connection = this.connection!;
    if (this.calls.has(callId)) throw new Error('调用 ID 已存在');
    const controller = new AbortController();
    this.calls.set(callId, controller);
    const started = performance.now();
    const options = { signal: controller.signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs };
    try {
      const result = method === 'tools/call' ? await client.callTool({ name, arguments: args }, options)
        : method === 'resources/read' ? await client.readResource({ uri: name }, options)
        : await client.getPrompt({ name, arguments: args as Record<string, string> }, options);
      return { result, callId, durationMs: performance.now() - started };
    } catch (error) {
      this.trace.add({ ...traceContext(connection), layer: 'system', direction: 'internal', kind: 'call-error', method, durationMs: performance.now() - started, data: { callId, name, error: error instanceof Error ? error.message : String(error) } });
      throw error;
    } finally { this.calls.delete(callId); }
  }
  cancel(id: string) { const controller = this.calls.get(id); controller?.abort(new Error('调用已取消')); return Boolean(controller); }

  private async close() {
    for (const controller of this.calls.values()) controller.abort(new Error('连接已关闭'));
    this.calls.clear();
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    if (transport instanceof StreamableHTTPClientTransport) {
      // Session termination is only meaningful for legacy servers; cap cleanup latency.
      await Promise.race([transport.terminateSession().catch(() => {}), new Promise(resolve => { const timer = setTimeout(resolve, 1000); timer.unref(); })]);
    }
    await client?.close().catch(() => {});
  }
  async disconnect() {
    if (this.changing) throw new Error('连接正在切换，请稍候');
    this.changing = true;
    try {
      if (this.connection) this.connection.status = 'disconnected';
      this.catalog = { tools: [], resources: [], prompts: [] };
      this.publish();
      await this.close();
    } finally { this.changing = false; }
  }
}
