import { listLayouts } from '@/lib/layouts';
import { removeLayout } from '@/app/actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Layouts' };

export default async function LayoutsPage() {
  let layouts: Awaited<ReturnType<typeof listLayouts>> = [];
  let error = '';
  try { layouts = await listLayouts(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  return (
    <>
      <div className="page-head">
        <div><h1>Layouts</h1><p className="muted">Reusable design slides saved by agents. Slots like {'{{title}}'} are filled when a slide is created from the layout.</p></div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {layouts.length === 0 && !error ? (
        <div className="empty">
          <b>No layouts yet</b>
          <p>Agents create layouts with the <code>save_layout</code> tool, then reuse them with <code>{'{ kind: "design", layout, fill }'}</code>.</p>
        </div>
      ) : (
        <div className="grid">
          {layouts.map(l => (
            <div key={l.id} className="card">
              <div className="slide-img" style={{ cursor: 'default' }}>
                {l.thumbnail
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={l.thumbnail} alt={`${l.name} thumbnail`} />
                  : <span className="missing">No thumbnail</span>}
              </div>
              <span className="card-title">{l.name}</span>
              {l.description && <span className="muted">{l.description}</span>}
              <span className="row" style={{ flexWrap: 'wrap' }}>
                {l.placeholders.map(p => <span key={p} className="chip">{`{{${p}}}`}</span>)}
              </span>
              <form action={removeLayout.bind(null, l.name)}>
                <button className="btn sm danger">Delete</button>
              </form>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
