'use client';
import { useActionState } from 'react';
import { createKeyAction } from './key-actions';

export function KeyForm({ url }: { url: string }) {
  const [state, action, pending] = useActionState(createKeyAction, null);
  const snippet = state?.key
    ? `# Claude Code
claude mcp add --transport http carousel-studio ${url} --header "Authorization: Bearer ${state.key}"

# Codex (~/.codex/config.toml)
[mcp_servers.carousel-studio]
url = "${url}"
http_headers = { Authorization = "Bearer ${state.key}" }

# Cursor (.cursor/mcp.json)
{ "mcpServers": { "carousel-studio": { "url": "${url}", "headers": { "Authorization": "Bearer ${state.key}" } } } }`
    : '';
  return (
    <form action={action} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <label htmlFor="agent-name">Agent name</label>
        <input id="agent-name" name="name" required placeholder="claude-code, codex, cursor, nightly-script" />
      </div>
      <button className="btn primary" disabled={pending}>{pending ? 'Creating…' : 'Create key'}</button>
      {state?.key && (
        <>
          <p className="error" style={{ color: 'inherit' }}><b>Copy it now.</b> The key for {state.name} is shown only once.</p>
          <textarea readOnly rows={12} className="mono" value={snippet} onFocus={e => e.currentTarget.select()} />
        </>
      )}
    </form>
  );
}
