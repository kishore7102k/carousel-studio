import { headers } from 'next/headers';
import { listKeys } from '@/lib/auth';
import { KeyForm } from './keys';
import { revokeKey } from './key-actions';

export const dynamic = 'force-dynamic';

export default async function Agents() {
  const keys = await listKeys();
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
              <span className="row"><b>{k.name}</b>{k.scopes.map(sc => <span key={sc} className="chip">{sc}</span>)}<span className="muted">last used {k.lastUsedAt ? k.lastUsedAt.toLocaleString() : 'never'}</span></span>
              <form action={revokeKey.bind(null, k.id)}><button className="btn sm danger">Revoke</button></form>
            </div>
          ))}
        </section>
      </div>
      <section className="form-card">
        <h2>MCP endpoint</h2>
        <p className="mono">{url}</p>
        <p className="muted">Streamable HTTP with header <code>Authorization: Bearer &lt;key&gt;</code>. Tools cover carousels, slides, versions, rendering, requests, brand, keys and activity: call <code>tools/list</code> or see the README for the full list. Read keys use read tools only, write keys edit carousels, admin keys also manage brand, keys and permanent delete.</p>
      </section>
    </>
  );
}
