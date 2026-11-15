// Server error log: MCP tool failures, page/route/action errors (src/instrumentation.ts) and renderer recoveries.
// Best-effort: logging never throws. Secrets (API keys, OAuth tokens/codes, client secrets, bearer headers,
// passwords in URLs) are redacted before anything is stored.
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { getDb, schema } from '@/db';

export type ErrorSource = 'mcp' | 'render' | 'page' | 'route' | 'action' | 'proxy';

const SECRET = /\b(ks|sat|srt|sac|scs)_[A-Za-z0-9_-]{8,}|vercel_blob_rw_[A-Za-z0-9_]+|npg_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9._~+/=-]+|(password|secret|token|code_verifier)=([^&\s"']+)/gi;
export const redact = (s: string) => s.replace(SECRET, (m, _p, k) => (k ? `${k}=[redacted]` : '[redacted]'));

/** Errors that are the caller's mistake and were reported clearly to them: logged, but hidden by default. */
const EXPECTED = /^(stale: |missing scope|invalid slides?|invalid input|Input validation|empty patch|nothing to update|carousel .* not found|request .* not found|version \d+ not found|current version \d+ not found|carousel is (in|not in) the trash|slide \d+ (is a legacy|does not exist)|unknown layout|layout ".*" (needs|has no)|layout name must|Template slides|templates were removed|from and to are the same|no rendered images|no such slides|the slide tried to navigate|fonts too large|font .* is not woff|tokens needs|unknown role|unknown color token|refusing to revoke|request is held by another agent|not found)/i;
export const isExpected = (message: string) => EXPECTED.test(message.trim());

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

export async function logError(e: {
  source: ErrorSource;
  error: unknown;
  route?: string | null;
  tool?: string | null;
  actor?: string | null;
  detail?: Record<string, unknown> | null;
  carouselId?: string | null;
  expected?: boolean;
}) {
  try {
    const err = e.error;
    const message = redact(err instanceof Error ? err.message : String(err)) || '(no message)';
    const digest = typeof err === 'object' && err !== null && 'digest' in err ? String((err as { digest: unknown }).digest) : undefined;
    const stack = err instanceof Error && err.stack ? redact(err.stack.split('\n').slice(0, 12).join('\n')) : null;
    let detail: Record<string, unknown> | null = null;
    if (e.detail) {
      const s = redact(JSON.stringify(e.detail));
      detail = s.length <= 4000 ? JSON.parse(s) : { truncated: `${s.slice(0, 4000)}…` };
    }
    const db = getDb();
    await db.insert(schema.errorLog).values({
      source: e.source,
      route: clip(e.route ? redact(e.route.split('?')[0]) : null, 300),
      tool: e.tool ?? null,
      actor: e.actor ?? null,
      message: clip(message, 2000)!,
      stack: clip(stack, 4000),
      detail: digest ? { ...(detail ?? {}), digest } : detail,
      carouselId: e.carouselId && /^[0-9a-f-]{36}$/i.test(e.carouselId) ? e.carouselId : null,
      expected: e.expected ?? isExpected(message),
    });
    // keep 30 days (cheap, ~1 in 25 inserts)
    if (Math.random() < 0.04) await db.delete(schema.errorLog).where(lt(schema.errorLog.at, new Date(Date.now() - 30 * 86_400_000)));
  } catch (logErr) {
    console.error('error log failed', logErr instanceof Error ? logErr.message : logErr);
  }
}

export async function listErrors(opts: { limit?: number; includeExpected?: boolean; source?: string } = {}) {
  const { errorLog } = schema;
  return getDb().select().from(errorLog)
    .where(and(opts.includeExpected ? undefined : eq(errorLog.expected, false), opts.source ? eq(errorLog.source, opts.source) : undefined))
    .orderBy(desc(errorLog.at)).limit(Math.min(opts.limit ?? 50, 200));
}

/** Unexpected errors in the last 24 h (sidebar badge). Never throws: the layout must render even if this fails. */
export async function countRecentErrors() {
  try {
    const { errorLog } = schema;
    const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(errorLog)
      .where(and(eq(errorLog.expected, false), gt(errorLog.at, new Date(Date.now() - 86_400_000))));
    return r?.n ?? 0;
  } catch { return 0; }
}

export async function clearErrors() {
  const rows = await getDb().delete(schema.errorLog).returning({ id: schema.errorLog.id });
  return rows.length;
}
