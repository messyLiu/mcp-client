import type { Profile, SessionState } from '../shared/types.js';
import { McpManager } from './mcp.js';
import { TraceStore } from './trace.js';

export class McpPool {
  private clients = new Map<string, McpManager>();
  private pending = new Map<string, Promise<SessionState>>();
  activeProfileId: string | null = null;
  constructor(readonly trace: TraceStore) {}
  get sessions(): SessionState[] {
    return [...this.clients.values()].flatMap(client => client.connection ? [{ connection: client.connection, catalog: client.catalog }] : []);
  }
  get connection() { return this.activeProfileId ? this.clients.get(this.activeProfileId)?.connection ?? null : null; }
  get catalog() { return this.activeProfileId ? this.clients.get(this.activeProfileId)?.catalog ?? { tools: [], resources: [], prompts: [] } : { tools: [], resources: [], prompts: [] }; }
  async connect(profile: Profile, secret?: string, reuse = false): Promise<SessionState> {
    this.activeProfileId = profile.id;
    let client = this.clients.get(profile.id);
    if (!client) { client = new McpManager(this.trace); this.clients.set(profile.id, client); }
    if (this.pending.has(profile.id)) return this.pending.get(profile.id)!;
    if (reuse && client.connection?.status === 'connected') return { connection: client.connection, catalog: client.catalog };
    const attempt = client.connect(profile, secret);
    this.pending.set(profile.id, attempt);
    try { return await attempt; } finally { this.pending.delete(profile.id); }
  }
  private getClient(profileId?: string) {
    const client = this.clients.get(profileId ?? this.activeProfileId ?? '');
    if (!client) throw new Error('请先连接该 MCP 服务');
    return client;
  }
  refreshCatalog(profileId?: string) { return this.getClient(profileId).refreshCatalog(); }
  call(id: string, method: 'tools/call' | 'resources/read' | 'prompts/get', name: string, args: Record<string, unknown>, profileId?: string) { return this.getClient(profileId).call(id, method, name, args); }
  cancel(id: string, profileId?: string) { return this.getClient(profileId).cancel(id); }
  async disconnect(profileId = this.activeProfileId ?? '') { await this.clients.get(profileId)?.disconnect(); }
  async remove(profileId: string) {
    if (this.pending.has(profileId)) throw new Error('该 MCP 正在连接，请稍候再删除');
    await this.disconnect(profileId);
    this.clients.delete(profileId);
    if (this.activeProfileId === profileId) this.activeProfileId = null;
    this.trace.emit('session-removed', { profileId });
  }
  async closeAll() { await Promise.allSettled([...this.clients.values()].map(client => client.disconnect())); }
}
