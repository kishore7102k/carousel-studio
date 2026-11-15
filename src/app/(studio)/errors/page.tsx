import Link from 'next/link';
import { listErrors } from '@/lib/errors';
import { clearErrorLog } from '@/app/actions';
import { LocalTime } from '@/components/LocalTime';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Errors' };

export default async function ErrorsPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const { all } = await searchParams;
  const includeExpected = all === '1';
  let rows: Awaited<ReturnType<typeof listErrors>> = [];
  let failed = '';
  try { rows = await listErrors({ limit: 100, includeExpected }); } catch (e) { failed = e instanceof Error ? e.message : String(e); }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Errors</h1>
          <p className="muted">Server errors from MCP tools, pages, server actions and the renderer (secrets redacted, kept 30 days). Agents with an admin key can read them with <code>list_errors</code>.</p>
        </div>
        <span className="row">
          <Link className={`btn sm${includeExpected ? '' : ' primary'}`} href="/errors">Unexpected</Link>
          <Link className={`btn sm${includeExpected ? ' primary' : ''}`} href="/errors?all=1">All (incl. caller mistakes)</Link>
          {rows.length > 0 && <form action={clearErrorLog}><button className="btn sm danger">Clear log</button></form>}
        </span>
      </div>
      {failed && <p className="error" role="alert">{failed}</p>}
      {!failed && rows.length === 0 ? (
        <div className="empty">
          <b>{includeExpected ? 'Nothing logged' : 'No unexpected errors'}</b>
          <p>{includeExpected ? 'No errors in the last 30 days.' : 'Everything is healthy. Caller mistakes (stale versions, not found, validation) are under "All".'}</p>
        </div>
      ) : (
        <section className="panel" aria-label="Error log">
          {rows.map(r => (
            <details key={r.id} className="req">
              <summary className="row" style={{ cursor: 'pointer' }}>
                <span className={`chip${r.expected ? '' : ' open'}`}>{r.source}</span>
                {r.tool && <span className="chip">{r.tool}</span>}
                {r.route && <span className="mono muted">{r.route}</span>}
                <span className="muted"><LocalTime value={r.at} /></span>
                {r.actor && <span className="muted">by {r.actor}</span>}
                {r.carouselId && <Link href={`/c/${r.carouselId}`}>carousel</Link>}
              </summary>
              <p className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.message}</p>
              {r.stack && <pre className="mono muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{r.stack}</pre>}
              {r.detail && <pre className="mono muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{JSON.stringify(r.detail, null, 2)}</pre>}
            </details>
          ))}
        </section>
      )}
    </>
  );
}
