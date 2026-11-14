import Link from 'next/link';
import { listCarousels } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function Gallery() {
  const items = await listCarousels();
  return (
    <>
      <div className="page-head">
        <h1>Carousels</h1>
        <span className="muted">{items.length} total</span>
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
