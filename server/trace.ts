import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { TraceEvent } from '../shared/types.js';

const SENSITIVE = /authorization|cookie|password|secret|token|api.?key|credential/i;
const MAX_TEXT = 64 * 1024;

export class TraceStore extends EventEmitter {
  private sequence = 0;
  events: TraceEvent[] = [];
  secrets = new Set<string>();
  constructor(readonly limit = 1000) { super(); }

  redact(value: unknown): unknown {
    if (typeof value === 'string') {
      let text = value;
      for (const secret of this.secrets) {
        if (secret) text = text.split(secret).join('[REDACTED]');
      }
      // Also cover sensitive fields inside raw JSON, URLs and SSE frames.
      text = text.replace(/("[^"\n]*(?:password|secret|token|api.?key|authorization|cookie)[^"\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"');
      text = text.replace(/([?&](?:[^=&]*(?:token|key|secret|password)[^=&]*)=)[^&#\s]*/gi, '$1[REDACTED]');
      return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n…[内容已截断]' : text;
    }
    if (Array.isArray(value)) return value.map(v => this.redact(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : this.redact(v)]));
    return value;
  }

  add(event: Omit<TraceEvent, 'id' | 'time'>) {
    const serialized = JSON.stringify(this.redact(event.data)) ?? 'null';
    const truncated = serialized.length > MAX_TEXT;
    const record: TraceEvent = { ...event, id: ++this.sequence, time: new Date().toISOString(), data: truncated ? serialized.slice(0, MAX_TEXT) + '\n…[内容已截断]' : JSON.parse(serialized), truncated: event.truncated || truncated };
    this.events.push(record);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    this.emit('trace', record);
    return record;
  }
  clear() { this.events = []; this.emit('clear'); }
}

export function instrumentFetch(store: TraceStore, connectionId: string, headers: Record<string, string>, fetchImpl: typeof fetch = fetch, allowedOrigin?: string): typeof fetch {
  return async (input, init) => {
    const targetUrl = new URL(input instanceof Request ? input.url : String(input));
    if (allowedOrigin && targetUrl.origin !== allowedOrigin) throw new Error('MCP 服务要求访问另一来源的端点，已阻止转发认证信息');
    const exchangeId = randomUUID();
    const start = performance.now();
    const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => requestHeaders.set(k, v));
    Object.entries(headers).forEach(([k, v]) => requestHeaders.set(k, v));
    const body = typeof init?.body === 'string' ? init.body : undefined;
    let rpc: Record<string, unknown> = {};
    try { rpc = body ? JSON.parse(body) : {}; } catch { /* raw non-JSON request */ }
    const common = { connectionId, layer: 'http' as const, exchangeId, method: typeof rpc.method === 'string' ? rpc.method : undefined, rpcId: typeof rpc.id === 'string' || typeof rpc.id === 'number' ? rpc.id : undefined };
    store.add({ ...common, direction: 'out', kind: 'request', data: { url: String(input instanceof Request ? input.url : input), method: init?.method ?? 'GET', headers: Object.fromEntries(requestHeaders), body } });
    let response: Response;
    try {
      response = await fetchImpl(input, { ...init, headers: requestHeaders, redirect: 'error' });
    } catch (error) {
      store.add({ ...common, direction: 'in', kind: 'network-error', durationMs: performance.now() - start, data: { error: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
    const responseMeta = { ...common, status: response.status };
    store.add({ ...responseMeta, direction: 'in', kind: 'headers', durationMs: performance.now() - start, data: { headers: Object.fromEntries(response.headers) } });
    if (!response.body) return response;
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    const decoder = new TextDecoder();
    let buffer = '';
    let truncated = false;
    let skipping = false;
    const emit = (data: string, kind: string) => store.add({ ...responseMeta, direction: 'in', kind, durationMs: performance.now() - start, data, truncated });
    const process = (text: string) => {
      // Keep streaming consumption bounded, even for a malformed event with no delimiter.
      buffer += text;
      if (sse) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          if (!skipping && frame.trim()) emit(frame, 'sse-frame');
          buffer = buffer.slice(boundary.index + boundary[0].length);
          skipping = false;
          truncated = false;
        }
        if (buffer.length > MAX_TEXT) {
          if (!skipping) { truncated = true; emit(buffer.slice(0, MAX_TEXT), 'sse-frame'); }
          buffer = buffer.slice(-3);
          skipping = true;
        }
      } else if (buffer.length > MAX_TEXT) {
        buffer = buffer.slice(0, MAX_TEXT);
        truncated = true;
      }
    };
    const observed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { process(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
      flush() { process(decoder.decode()); if (buffer && !skipping) emit(buffer, sse ? 'sse-frame' : 'body'); },
    }));
    const wrapped = new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(wrapped, 'url', { value: response.url });
    return wrapped;
  };
}
