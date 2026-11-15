import { Sidebar } from '@/components/Sidebar';
import { getBrand } from '@/lib/brand';
import { countRecentErrors } from '@/lib/errors';
import { listRequests } from '@/lib/store';

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const [active, brand, recentErrors] = await Promise.all([listRequests({ status: 'active' }), getBrand(), countRecentErrors()]);
  return (
    <div className="app">
      <Sidebar openRequests={active.length} brandName={brand.name} recentErrors={recentErrors} />
      <main className="main">{children}</main>
    </div>
  );
}
