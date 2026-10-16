import { z } from 'zod';

const forbiddenHeader = /^(host|content-length|connection|transfer-encoding|content-type|accept|mcp-.*|origin|sec-.*)$/i;
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine(v => !forbiddenHeader.test(v), '该请求头由传输层管理');
export const profileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().trim().min(1).max(80),
  url: z.url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash; }, '请输入 HTTP/HTTPS 地址，凭证请填入认证配置'),
  transport: z.enum(['http', 'sse']),
  auth: z.enum(['none', 'bearer', 'header']),
  authHeader: headerName,
  apiKey: z.string().max(8192).refine(v => !/[\r\n]/.test(v)).optional(),
  headers: z.array(z.object({ name: headerName, value: z.string().max(8192).refine(v => !/[\r\n]/.test(v)) })).max(30),
  timeoutMs: z.number().int().min(1000).max(300000),
  protocol: z.enum(['auto', 'legacy', 'modern']),
});
