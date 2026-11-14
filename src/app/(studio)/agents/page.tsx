import { LocalTime } from '@/components/LocalTime';
import { headers } from 'next/headers';
import { listKeys } from '@/lib/auth';
import { KeyForm } from './keys';
import { listConnectedApps } from '@/lib/oauth/connections';
import { revokeKey, disconnectApp } from './key-actions';

export const dynamic = 'force-dynamic';

export default async function Agents() {
  const [keys, apps] = await Promise.all([listKeys(), listConnectedApps()]);
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
          <h2>Connections</h2>
          <h3>API keys</h3>
          {keys.length === 0 && <p className="muted">No keys yet.</p>}
          {keys.map(k => (
            <div key={k.id} className="req">
              <span className="row"><b>{k.name}</b>{k.scopes.map(sc => <span key={sc} className="chip">{sc}</span>)}<span className="muted">last used {k.lastUsedAt ? <LocalTime value={k.lastUsedAt} /> : 'never'}</span></span>
              <form action={revokeKey.bind(null, k.id)}><button className="btn sm danger">Revoke</button></form>
            </div>
          ))}
          <h3>Connected apps</h3>
          {apps.length === 0 && <p className="muted">No web apps connected.</p>}
          {apps.map(a => (
            <div key={a.id} className="req">
              <span className="row"><b>{a.name}</b><span className="muted">{a.redirectHost}</span>{a.scopes.map(sc => <span key={sc} className="chip">{sc}</span>)}<span className="muted">connected {<LocalTime value={a.connectedAt} />}</span><span className="muted">last used {a.lastUsedAt ? <LocalTime value={a.lastUsedAt} /> : 'never'}</span></span>
              <form action={disconnectApp.bind(null, a.id)}><button className="btn sm danger">Disconnect</button></form>
            </div>
          ))}
        </section>
      </div>
      <section className="form-card">
        <h2>Connect a web app</h2>
        <p className="muted">ChatGPT, Claude.ai and Gemini connect by URL and sign in with your studio password. Use this MCP URL:</p>
        <p className="mono">{url}</p>
        <ul>
          <li><b>ChatGPT:</b> Settings → Apps &amp; Connectors → Advanced → turn Developer mode on → Create / &quot;Add custom MCP server&quot; → URL above, Authentication <b>OAuth</b> → sign in → Allow.</li>
          <li><b>Claude.ai:</b> Settings → Connectors → Add custom connector → paste the URL → Connect → sign in → Allow.</li>
          <li><b>Gemini app:</b> Settings → Connected apps → Add custom app (MCP) → paste the URL → sign in → Allow (availability depends on Google&apos;s region and plan rules).</li>
        </ul>
        <p className="muted">Coding agents (Claude Code, Codex, Cursor) keep using API keys.</p>
      </section>
      <section className="form-card">
        <h2>MCP endpoint</h2>
        <p className="mono">{url}</p>
        <p className="muted">Streamable HTTP with header <code>Authorization: Bearer &lt;key&gt;</code>. Tools cover carousels, slides, versions, rendering, requests, brand, keys and activity: call <code>tools/list</code> or see the README for the full list. Read keys use read tools only, write keys edit carousels, admin keys also manage brand, keys and permanent delete.</p>
      </section>
    </>
  );
}
