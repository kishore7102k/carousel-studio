import { Sidebar } from '@/components/Sidebar';
import { getBrand } from '@/lib/brand';
import { listRequests } from '@/lib/store';

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const [active, brand] = await Promise.all([listRequests({ status: 'active' }), getBrand()]);
  return (
    <div className="app">
      <Sidebar openRequests={active.length} brandName={brand.name} />
      <main className="main">{children}</main>
    </div>
  );
}
