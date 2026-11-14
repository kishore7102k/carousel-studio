import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defineTool } from '@/lib/mcp/define';
import { brandGuideText } from '@/lib/mcp/guide';

export function registerBrandTools(server: McpServer) {
  defineTool(server, 'get_brand_guide', {
    title: 'Get brand guide',
    description: 'Agent workflow, slide JSON format and the active brand book. Read once per session before writing or editing slides. Explains scopes, 1-based slide numbers, baseVersion and the trash.',
    inputSchema: z.object({}),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async () => ({ content: [{ type: 'text', text: await brandGuideText() }] }));
}
