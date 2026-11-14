import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { getDb, schema } from '@/db';

// ---------- URL helper ----------

export function studioUrl(path = '') {
  const base =
    process.env.STUDIO_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'http://localhost:3000');
  return `${base}${path}`;
}

// ---------- Activity log ----------

export async function logActivity(
  actor: string,
  action: string,
  carouselId?: string | null,
  detail?: Record<string, unknown> | null,
) {
  try {
    await getDb()
      .insert(schema.activity)
      .values({ actor, action, carouselId: carouselId ?? null, detail: detail ?? null });
  } catch {
    // best-effort: logging failures must never surface to the caller
  }
}

// ---------- Scope helpers ----------

type Scope = 'read' | 'write' | 'admin';

/** admin ⊇ write ⊇ read */
function hasScope(callerScopes: string[], required: Scope): boolean {
  if (required === 'read') return callerScopes.some(s => ['read', 'write', 'admin'].includes(s));
  if (required === 'write') return callerScopes.some(s => ['write', 'admin'].includes(s));
  return callerScopes.includes('admin');
}

// ---------- Tool context types ----------

export type McpCtx = { http?: { authInfo?: { clientId?: string; scopes?: string[] } } };

export function agentOf(ctx: McpCtx): string {
  return ctx.http?.authInfo?.clientId ?? 'agent';
}

function scopesOf(ctx: McpCtx): string[] {
  return ctx.http?.authInfo?.scopes ?? ['read', 'write'];
}

// ---------- Result helpers (re-exported for tools) ----------

export type ToolResult = {
  content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
  isError?: boolean;
};

export const json = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

export const fail = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

// ---------- defineTool ----------

type AnnotationSet = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type ToolDef<S extends z.ZodTypeAny> = {
  title: string;
  description: string;
  inputSchema: S;
  scope: Scope;
  annotations?: AnnotationSet;
};

/**
 * Registers a tool on the MCP server with:
 * - Scope enforcement (returns `isError` with "missing scope: X" when insufficient)
 * - Error catching (returns `isError` with the error message, never a stack trace)
 * - Activity logging for every `write` / `admin` tool call (best-effort)
 */
export function defineTool<S extends z.ZodTypeAny>(
  server: McpServer,
  name: string,
  def: ToolDef<S>,
  handler: (args: z.infer<S>, ctx: McpCtx) => Promise<ToolResult>,
) {
  const { title, description, inputSchema, scope, annotations = {} } = def;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    name,
    {
      title,
      description,
      inputSchema,
      annotations: { openWorldHint: false, ...annotations },
    },
    async (args: z.infer<S>, ctx: unknown) => {
      const typedCtx = ctx as McpCtx;
      const callerScopes = scopesOf(typedCtx);

      // 1. Scope check
      if (!hasScope(callerScopes, scope)) {
        return fail(`missing scope: ${scope}`);
      }

      // 2. Run handler
      let result: ToolResult;
      try {
        result = await handler(args, typedCtx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(msg);
      }

      // 3. Activity log for write / admin tools (best-effort)
      if (scope !== 'read' && !result.isError) {
        const actor = agentOf(typedCtx);
        // Extract carousel id from common argument names
        const a = args as Record<string, unknown>;
        const carouselId =
          typeof a.id === 'string'
            ? a.id
            : typeof a.carouselId === 'string'
              ? a.carouselId
              : null;
        // Build a compact detail object without base64 blobs
        const detail: Record<string, unknown> = { tool: name };
        for (const [k, v] of Object.entries(a)) {
          if (['slides', 'fonts', 'tokens', 'base64'].includes(k)) continue;
          if (typeof v === 'string' && v.length > 500) continue;
          detail[k] = v;
        }
        void logActivity(actor, name, carouselId, detail);
      }

      return result;
    },
  );
}
