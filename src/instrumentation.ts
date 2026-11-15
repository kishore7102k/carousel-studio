import type { Instrumentation } from 'next';

/**
 * Server errors from pages (server components), route handlers, server actions and the proxy go to the studio's
 * error log (Errors page / list_errors). Logging is best-effort and never throws; secrets are redacted.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return; // the DB client and logger are Node-only
  const { logError } = await import('@/lib/errors');
  const kind = context.routeType;
  await logError({
    source: kind === 'render' ? 'page' : kind,
    error: err,
    route: request.path,
    detail: { method: request.method, routePath: context.routePath, renderSource: (context as { renderSource?: string }).renderSource },
  });
};
