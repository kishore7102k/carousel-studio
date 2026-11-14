import { getBrand, roleColor, family, ROLES } from '@/lib/brand';
import { DetailsForm, ImportForm } from './forms';
import { resetToDefault } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Brand' };

export default async function BrandPage() {
  const b = await getBrand();
  const fonts = [...new Set(b.fonts.map(f => `${f.family} ${f.weight}`))];
  return (
    <>
      <div className="page-head">
        <div><h1>Brand</h1><p className="muted">Colors, fonts and voice used to render every slide and guide every agent.</p></div>
        <form action={resetToDefault}><button className="btn sm danger">Reset to default pack</button></form>
      </div>
      <section className="form-card">
        <h2>{b.name}</h2>
        <div className="swatches">
          {ROLES.map(r => (
            <div key={r} className="sw"><i style={{ background: roleColor(b, r) }} /><span><b>{r}</b><code>{b.roles[r] ? `${b.roles[r]} · ` : ''}{roleColor(b, r)}</code></span></div>
          ))}
        </div>
        <p className="muted">Fonts: {fonts.join(', ') || 'none uploaded (system fallback)'} · sans <code>{family(b, 'sans')}</code></p>
      </section>
      <div className="forms">
        <DetailsForm name={b.name} handle={b.handle} labelPrefix={b.labelPrefix} readme={b.readme} roles={JSON.stringify(b.roles, null, 2)} />
        <ImportForm />
      </div>
    </>
  );
}
