import { randomUUID } from 'node:crypto';
import { profileSchema } from './config.js';
import type { ProfileInput } from '../shared/types.js';

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function parseMcpConfig(text: string, existingNames: string[] = []) {
  let root: unknown;
  try { root = JSON.parse(text); } catch { throw new Error('JSON 格式有误，请检查双引号、逗号和括号'); }
  if (!isObject(root)) throw new Error('配置必须是 JSON 对象');
  const servers = 'mcpServers' in root ? root.mcpServers : typeof root.url === 'string' ? { [typeof root.name === 'string' ? root.name : '导入的 MCP 服务']: root } : undefined;
  if (!isObject(servers) || !Object.keys(servers).length) throw new Error('未找到服务配置，请提供非空 mcpServers 对象，或含 url 的单个服务配置');
  if (Object.keys(servers).length > 50) throw new Error('一次最多识别 50 个服务');
  const inputs: ProfileInput[] = [];
  const issues: string[] = [];
  const usedNames = new Set(existingNames);
  for (const [name, value] of Object.entries(servers)) {
    try {
      if (!isObject(value)) throw new Error('服务配置必须是对象');
      if (value.disabled === true) throw new Error('该服务已标记为 disabled，已跳过');
      const kind = String(value.type ?? value.transport ?? 'http').toLowerCase();
      if (kind === 'stdio' || (!value.url && value.command)) throw new Error('当前版本不支持 stdio 本地命令');
      if (!['streamable_http', 'streamable-http', 'streamablehttp', 'http', 'sse'].includes(kind)) throw new Error('不支持此传输类型，请使用 streamable_http、http 或 sse');
      if (typeof value.url !== 'string') throw new Error('缺少 url 地址');
      if (value.headers !== undefined && !isObject(value.headers)) throw new Error('headers 必须是 JSON 对象');
      const headers = Object.entries(value.headers ?? {}).map(([header, v]) => {
        if (typeof v !== 'string') throw new Error('headers 的值必须是字符串');
        return { name: header, value: v };
      });
      const lowerNames = headers.map(h => h.name.toLowerCase());
      if (new Set(lowerNames).size !== lowerNames.length) throw new Error('请求头名称不能重复（不区分大小写）');
      const bearer = headers.find(h => h.name.toLowerCase() === 'authorization' && /^Bearer\s+\S/i.test(h.value));
      const keyHeader = headers.find(h => ['x-api-key', 'api-key', 'apikey'].includes(h.name.toLowerCase()));
      let auth: ProfileInput['auth'] = 'none';
      let apiKey: string | undefined;
      let authHeader = 'X-API-Key';
      let extracted: typeof bearer;
      if (bearer) { auth = 'bearer'; apiKey = bearer.value.replace(/^Bearer\s+/i, '').trim(); extracted = bearer; }
      else if (keyHeader) { auth = 'header'; apiKey = keyHeader.value; authHeader = keyHeader.name; extracted = keyHeader; }
      else if (value.apiKey !== undefined) {
        if (typeof value.apiKey !== 'string') throw new Error('apiKey 必须是字符串');
        apiKey = value.apiKey;
        auth = typeof value.authHeader === 'string' ? 'header' : 'bearer';
        if (typeof value.authHeader === 'string') authHeader = value.authHeader;
      }
      let finalName = name.trim();
      let suffix = 2;
      while (usedNames.has(finalName)) finalName = `${name.trim().slice(0, 70)} (${suffix++})`;
      const parsed = profileSchema.safeParse({
        id: randomUUID(), name: finalName, url: value.url.trim(), transport: kind === 'sse' ? 'sse' : 'http',
        auth, authHeader, apiKey, headers: headers.filter(h => h !== extracted), timeoutMs: value.timeoutMs ?? 30000, protocol: 'auto',
      });
      if (!parsed.success) throw new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；'));
      usedNames.add(finalName);
      inputs.push(parsed.data);
      const extra = Object.keys(value).filter(k => !['type', 'transport', 'url', 'name', 'headers', 'apiKey', 'authHeader', 'timeoutMs', 'disabled'].includes(k));
      if (extra.length) issues.push(`${name}：未导入额外字段 ${extra.join('、')}`);
    } catch (error) { issues.push(`${name}：${error instanceof Error ? error.message : String(error)}`); }
  }
  return { inputs, issues };
}
