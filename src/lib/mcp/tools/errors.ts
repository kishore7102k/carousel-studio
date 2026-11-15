import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { listErrors } from '@/lib/errors';
import { defineTool, json } from '@/lib/mcp/define';

export function registerErrorTools(server: McpServer) {
  defineTool(server, 'list_errors', {
    title: 'List server errors',
    description: 'Admin. Recent server errors, newest first: failed MCP tool calls, page / route / server-action errors and renderer recoveries, with source, route or tool, actor, message, stack (secrets redacted) and time. By default only UNEXPECTED errors (bugs, crashes, infrastructure); includeExpected adds caller mistakes that were already reported to the caller (stale versions, not found, validation). Use it to diagnose a failure or check the studio is healthy.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 30)'),
      includeExpected: z.boolean().optional().describe('Also show caller mistakes (default false)'),
      source: z.enum(['mcp', 'render', 'page', 'route', 'action', 'proxy']).optional(),
    }),
    scope: 'admin',
    annotations: { readOnlyHint: true },
  }, async ({ limit, includeExpected, source }) => {
    const rows = await listErrors({ limit: limit ?? 30, includeExpected, source });
    return json({ count: rows.length, errors: rows.map(r => ({ ...r, stack: r.stack?.split('\n').slice(0, 6).join('\n') ?? null })) });
  });
}
