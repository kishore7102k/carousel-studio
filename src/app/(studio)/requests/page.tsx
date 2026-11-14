import Link from 'next/link';
import { listRequests } from '@/lib/store';
import { dismissRequest } from '@/app/actions';
import { AutoRefresh } from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';

export default async function Requests() {
  const [active, done] = await Promise.all([listRequests({ status: 'active' }), listRequests({ status: 'done' })]);
  return (
    <>
      <AutoRefresh active={active.length > 0} />
      <div className="page-head"><h1>Requests</h1><span className="muted">{active.length} waiting for an agent</span></div>
      <section className="panel">
        <h2>Waiting</h2>
        {active.length === 0 && <p className="muted">Nothing waiting. Pin a note on a slide or ask for a new carousel.</p>}
        {active.map(r => (
          <div key={r.id} className="req">
            <span className="row">
              <span className={`chip ${r.status}`}>{r.status}{r.claimedBy ? ` · ${r.claimedBy}` : ''}</span>
              <span className="chip">{r.kind === 'new' ? 'new carousel' : `slide ${(r.slideIndex ?? 0) + 1} · v${r.versionNumber}`}</span>
              {r.carouselId && <Link href={`/c/${r.carouselId}`} className="muted">open carousel</Link>}
            </span>
            <p>{r.text}</p>
            {r.status === 'open' && (
              <form action={dismissRequest.bind(null, r.id, r.carouselId)}><button className="btn sm">Dismiss</button></form>
            )}
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>Done</h2>
        {done.length === 0 && <p className="muted">No finished requests yet.</p>}
        {done.slice(-20).reverse().map(r => (
          <div key={r.id} className="req">
            <span className="row">
              <span className="chip done">done · {r.claimedBy}</span>
              {r.carouselId && <Link href={`/c/${r.carouselId}`} className="muted">open carousel{r.resultVersion ? ` (v${r.resultVersion})` : ''}</Link>}
            </span>
            <p>{r.text}</p>
            {r.reply && <p className="reply">{r.reply}</p>}
          </div>
        ))}
      </section>
    </>
  );
}
