'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/app/actions';

const I = {
  grid: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  palette: 'M12 22a10 10 0 1 1 10-10c0 2.2-1.8 3-4 3h-2a2 2 0 0 0-1 3.7A2 2 0 0 1 12 22zM7.5 10.5h.01M10.5 6.5h.01M15.5 7.5h.01',
  plus: 'M12 5v14M5 12h14',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};
const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

export function Sidebar({ openRequests, brandName }: { openRequests: number; brandName: string }) {
  const path = usePathname();
  const items = [
    { href: '/', label: 'Carousels', icon: I.grid, active: path === '/' || path.startsWith('/c/') },
    { href: '/requests', label: 'Requests', icon: I.inbox, badge: openRequests },
    { href: '/agents', label: 'Agents', icon: I.key },
    { href: '/brand', label: 'Brand', icon: I.palette },
  ];
  return (
    <aside className="sidebar">
      <Link href="/" className="product">
        <span className="logo" aria-hidden="true"><i /><i /><i /></span>
        <span>Carousel Studio</span>
      </Link>
      <Link href="/new" className="btn primary new"><Icon d={I.plus} />New carousel</Link>
      <nav aria-label="Main" className="side-nav">
        {items.map(it => (
          <Link key={it.href} href={it.href} className="side-link" aria-current={(it.active ?? path.startsWith(it.href)) ? 'page' : undefined}>
            <Icon d={it.icon} />
            <span>{it.label}</span>
            {!!it.badge && <span className="badge">{it.badge}</span>}
          </Link>
        ))}
      </nav>
      <div className="side-foot">
        <Link href="/brand" className="brand-chip" title="Active brand pack">
          <span className="muted">Brand</span>
          <b>{brandName}</b>
        </Link>
        <form action={signOut}>
          <button className="side-link as-button"><Icon d={I.out} /><span>Sign out</span></button>
        </form>
      </div>
    </aside>
  );
}
