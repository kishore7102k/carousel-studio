import { LocalTime } from '@/components/LocalTime';
import Link from 'next/link';
import { listCarousels } from '@/lib/store';
import { purgeCarousel, restoreCarousel } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function Gallery({ searchParams }: { searchParams: Promise<{ trash?: string }> }) {
  const { trash } = await searchParams;
  if (trash) return <Trash />;
  const items = await listCarousels();
  return (
    <>
      <div className="page-head">
        <h1>Carousels</h1>
        <span className="row"><span className="muted">{items.length} total</span><Link href="/" className="btn sm primary">Carousels</Link><Link href="/?trash=1" className="btn sm">Trash</Link></span>
      </div>
      {items.length === 0 ? (
        <div className="empty">
          <p>No carousels yet. Ask an agent for one or start from the template.</p>
          <Link href="/new" className="btn primary">New carousel</Link>
        </div>
      ) : (
        <div className="grid">
          {items.map(c => (
            <Link key={c.id} href={`/c/${c.id}`} className="card">
              <div className="thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {c.cover ? <img src={c.cover} alt={`${c.title} cover`} loading="lazy" /> : <span className="mono">Not rendered</span>}
              </div>
              <span className="card-title">{c.title}</span>
              <span className="row">
                <span className={`chip ${c.status}`}>{c.status}</span>
                <span className="chip">v{c.currentVersion}</span>
                {c.tipNumber && <span className="chip">#{String(c.tipNumber).padStart(3, '0')}</span>}
                {c.openRequests > 0 && <span className="chip open">{c.openRequests} open</span>}
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

async function Trash() {
  const items = (await listCarousels({ includeTrashed: true, limit: 200 })).filter(c => c.deletedAt);
  return (
    <>
      <div className="page-head">
        <h1>Trash</h1>
        <span className="row"><span className="muted">{items.length} in trash</span><Link href="/" className="btn sm">Carousels</Link><Link href="/?trash=1" className="btn sm primary">Trash</Link></span>
      </div>
      {items.length === 0 ? (
        <div className="empty"><p>Trash is empty.</p></div>
      ) : (
        <div className="grid">
          {items.map(c => (
            <div key={c.id} className="card">
              <div className="thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {c.cover ? <img src={c.cover} alt={`${c.title} cover`} loading="lazy" /> : <span className="mono">Not rendered</span>}
              </div>
              <span className="card-title">{c.title}</span>
              <span className="muted">deleted {c.deletedAt && <LocalTime value={c.deletedAt} dateOnly />}</span>
              <span className="row">
                <form action={restoreCarousel.bind(null, c.id)}><button className="btn sm">Restore</button></form>
                <form action={purgeCarousel.bind(null, c.id)}><button className="btn sm danger">Delete forever</button></form>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
