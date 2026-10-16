export type TransportKind = 'http' | 'sse';
export type AuthKind = 'none' | 'bearer' | 'header';
export interface Header { name: string; value: string }
export interface Profile {
  id: string;
  name: string;
  url: string;
  transport: TransportKind;
  auth: AuthKind;
  authHeader: string;
  headers: Header[];
  timeoutMs: number;
  protocol: 'auto' | 'legacy' | 'modern';
  hasSecret: boolean;
}
export type ProfileInput = Omit<Profile, 'hasSecret'> & { apiKey?: string };
export interface Connection {
  id: string;
  profileId: string;
  name: string;
  status: 'connecting' | 'connected' | 'error' | 'disconnected';
  serverName?: string;
  serverVersion?: string;
  protocol?: string;
  capabilities?: Record<string, unknown>;
  error?: string;
}
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: { type?: string; properties?: Record<string, Record<string, unknown>>; required?: string[]; [key: string]: unknown };
}
export interface ResourceInfo { name: string; uri: string; description?: string; mimeType?: string }
export interface PromptInfo { name: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }
export interface Catalog { tools: ToolInfo[]; resources: ResourceInfo[]; prompts: PromptInfo[] }
export interface SessionState { connection: Connection; catalog: Catalog }
export interface TraceEvent {
  id: number;
  time: string;
  connectionId: string;
  profileId?: string;
  connectionName?: string;
  layer: 'rpc' | 'http' | 'system';
  direction: 'out' | 'in' | 'internal';
  kind: string;
  method?: string;
  rpcId?: string | number;
  exchangeId?: string;
  status?: number;
  durationMs?: number;
  data: unknown;
  truncated?: boolean;
}
export interface CallResult { result: unknown; durationMs: number; callId: string }
