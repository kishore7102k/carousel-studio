import { desc } from 'drizzle-orm';
import { headers } from 'next/headers';
import { getDb, schema } from '@/db';
import { KeyForm, revokeKey } from './keys';

export const dynamic = 'force-dynamic';

export default async function Agents() {
  const keys = await getDb().select().from(schema.apiKeys).orderBy(desc(schema.apiKeys.createdAt));
  const h = await headers();
  const url = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}/api/mcp`;
  return (
    <>
      <div className="page-head"><h1>Agents</h1><span className="muted">One key per agent, so replies show who did what.</span></div>
      <div className="forms">
        <section className="form-card">
          <h2>Create a key</h2>
          <KeyForm url={url} />
        </section>
        <section className="form-card">
          <h2>Keys</h2>
          {keys.length === 0 && <p className="muted">No keys yet.</p>}
          {keys.map(k => (
            <div key={k.id} className="req">
              <span className="row"><b>{k.name}</b><span className="muted">last used {k.lastUsedAt ? k.lastUsedAt.toLocaleString() : 'never'}</span></span>
              <form action={revokeKey.bind(null, k.id)}><button className="btn sm danger">Revoke</button></form>
            </div>
          ))}
        </section>
      </div>
      <section className="form-card">
        <h2>MCP endpoint</h2>
        <p className="mono">{url}</p>
        <p className="muted">Streamable HTTP with header <code>Authorization: Bearer &lt;key&gt;</code>. Tools: get_brand_guide, list_carousels, get_carousel, create_carousel, update_slides, render_carousel, view_slides, set_carousel_status, list_requests, claim_request, complete_request.</p>
      </section>
    </>
  );
}
