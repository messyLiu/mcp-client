import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export function createDemoHandler() {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'Workbench Demo', version: '1.0.0' });
    server.registerTool('echo', {
      description: '回显你发送的消息，用于检查参数、响应和完整报文链路。',
      inputSchema: z.object({ message: z.string().describe('要回显的消息'), uppercase: z.boolean().default(false).describe('是否转换成大写') }),
    }, async ({ message, uppercase }) => ({ content: [{ type: 'text', text: uppercase ? message.toUpperCase() : message }], structuredContent: { message: uppercase ? message.toUpperCase() : message, receivedAt: new Date().toISOString() } }));
    server.registerTool('calculate', {
      description: '对两个数字进行加、减、乘、除运算。除以零时返回工具错误。',
      inputSchema: z.object({ operation: z.enum(['add', 'subtract', 'multiply', 'divide']), a: z.number(), b: z.number() }),
    }, async ({ operation, a, b }) => {
      if (operation === 'divide' && b === 0) return { isError: true, content: [{ type: 'text', text: '不能除以零' }] };
      const result = operation === 'add' ? a + b : operation === 'subtract' ? a - b : operation === 'multiply' ? a * b : a / b;
      return { content: [{ type: 'text', text: String(result) }], structuredContent: { result } };
    });
    server.registerTool('wait', {
      description: '等待指定时间后返回，可用来验证耗时、超时和取消调用。',
      inputSchema: z.object({ seconds: z.number().min(0).max(120).default(2) }),
    }, async ({ seconds }, ctx) => {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
        const timer = setTimeout(() => { ctx.mcpReq.signal.removeEventListener('abort', abort); resolve(); }, seconds * 1000);
        ctx.mcpReq.signal.addEventListener('abort', abort, { once: true });
        if (ctx.mcpReq.signal.aborted) abort();
      });
      return { content: [{ type: 'text', text: `已等待 ${seconds} 秒` }] };
    });
    server.registerResource('welcome', 'demo://welcome', { description: '工作台演示资源', mimeType: 'text/plain' }, async uri => ({ contents: [{ uri: uri.href, text: '欢迎使用 MCP Workbench。选择工具、填写参数，然后在报文时间线中查看每次交互。' }] }));
    server.registerPrompt('summarize', { description: '生成一个摘要提示词', argsSchema: z.object({ text: z.string() }) }, ({ text }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `请用三句话总结以下内容：\n${text}` } }] }));
    return server;
  });
}
