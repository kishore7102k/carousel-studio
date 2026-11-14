import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { logActivity } from '@/lib/store';

// ---------- URL helpers ----------

/** Public studio URL: STUDIO_URL, else the Vercel production domain, else localhost. */
export function studioUrl(path = '') {
  const base =
    process.env.STUDIO_URL?.replace(/\/+$/, '') ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'http://localhost:3000');
  return `${base}${path}`;
}

export const carouselUrl = (id: string) => studioUrl(`/c/${id}`);

// ---------- Scopes ----------

export type Scope = 'read' | 'write' | 'admin';

/** admin ⊇ write ⊇ read */
const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };
export function hasScope(callerScopes: string[], required: Scope): boolean {
  return callerScopes.some(s => (RANK[s] ?? 0) >= RANK[required]);
}

// ---------- Tool context ----------

export type McpCtx = {
  http?: { authInfo?: { clientId?: string; scopes?: string[]; extra?: Record<string, unknown> } };
};

export const agentOf = (ctx: McpCtx): string => ctx.http?.authInfo?.clientId ?? 'agent';
export const keyIdOf = (ctx: McpCtx): string | null => {
  const id = ctx.http?.authInfo?.extra?.keyId;
  return typeof id === 'string' ? id : null;
};
// Auth is required on /api/mcp, so a missing authInfo only happens in tests; treat it as no scopes.
const scopesOf = (ctx: McpCtx): string[] => ctx.http?.authInfo?.scopes ?? [];

// ---------- Results ----------

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = {
  content: Content[];
  isError?: boolean;
  /** Not sent to the client. Overrides what defineTool writes to the activity log. */
  activity?: { carouselId?: string | null; detail?: Record<string, unknown> };
};

export const json = (data: unknown, activity?: ToolResult['activity']): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  ...(activity ? { activity } : {}),
});

export const fail = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

// ---------- defineTool ----------

type Annotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: false;
};

type ToolDef<S extends z.ZodType> = {
  title: string;
  description: string;
  inputSchema: S;
  scope: Scope;
  annotations?: Annotations;
  /** Which input field holds the carousel id, for the activity log. Handlers can override via result.activity. */
  carouselArg?: 'id' | 'carouselId';
};

/** Keys never copied into activity detail (large or binary). */
const SKIP_DETAIL = new Set(['slides', 'slide', 'fonts', 'tokens', 'readme', 'base64']);

function compactDetail(args: Record<string, unknown>) {
  const detail: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (SKIP_DETAIL.has(k) || v === undefined) continue;
    const s = JSON.stringify(v);
    detail[k] = s && s.length > 300 ? '[omitted]' : v;
  }
  return detail;
}

/**
 * Registers a tool with:
 * - scope enforcement (`missing scope: X` error result),
 * - error catching (readable message, never a stack trace),
 * - an activity row for every successful write/admin call (actor = agent name).
 */
export function defineTool<S extends z.ZodType>(
  server: McpServer,
  name: string,
  def: ToolDef<S>,
  handler: (args: z.infer<S>, ctx: McpCtx) => Promise<ToolResult>,
) {
  const { title, description, inputSchema, scope, annotations = {}, carouselArg } = def;
  server.registerTool(
    name,
    { title, description, inputSchema, annotations: { ...annotations, openWorldHint: false } },
    // The SDK infers args from the schema; our handler signature is the same shape.
    (async (args: z.infer<S>, rawCtx: unknown) => {
      const ctx = rawCtx as McpCtx;
      if (!hasScope(scopesOf(ctx), scope)) return fail(`missing scope: ${scope}`);

      let result: ToolResult;
      try {
        result = await handler(args, ctx);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }

      const { activity, ...out } = result;
      if (scope !== 'read' && !out.isError) {
        const a = (args ?? {}) as Record<string, unknown>;
        const fromArgs = carouselArg && typeof a[carouselArg] === 'string' ? (a[carouselArg] as string) : null;
        await logActivity(
          agentOf(ctx),
          name,
          activity && 'carouselId' in activity ? activity.carouselId ?? null : fromArgs,
          { ...compactDetail(a), ...activity?.detail },
        );
      }
      return out;
    }) as never,
  );
}
