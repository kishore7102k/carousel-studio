'use client';
import { useActionState } from 'react';
import { importBrandPack, updateBrandDetails } from './actions';

type Result = { ok?: string; error?: string } | null;
const Status = ({ s }: { s: Result }) => s?.error ? <p className="error" role="alert">{s.error}</p> : s?.ok ? <p className="notice" role="status">{s.ok}</p> : null;

export function DetailsForm({ name, handle, labelPrefix, readme, roles }: { name: string; handle: string; labelPrefix: string; readme: string; roles: string }) {
  const [state, action, pending] = useActionState<Result, FormData>(updateBrandDetails, null);
  return (
    <form action={action} className="form-card">
      <h2>Details</h2>
      <div className="forms" style={{ gap: 12 }}>
        <div><label htmlFor="b-name">Brand name</label><input id="b-name" name="name" defaultValue={name} required /></div>
        <div><label htmlFor="b-handle">Handle on slides</label><input id="b-handle" name="handle" defaultValue={handle} required /></div>
        <div><label htmlFor="b-label">Cover label prefix</label><input id="b-label" name="labelPrefix" defaultValue={labelPrefix} required /></div>
      </div>
      <div>
        <label htmlFor="b-roles">Color roles (JSON: role → your token name)</label>
        <textarea id="b-roles" name="roles" rows={4} className="mono" defaultValue={roles} spellCheck={false} />
      </div>
      <div>
        <label htmlFor="b-readme">Brand guide for agents (voice, rules)</label>
        <textarea id="b-readme" name="readme" rows={10} defaultValue={readme} />
      </div>
      <Status s={state} />
      <button className="btn primary" disabled={pending} style={{ alignSelf: 'flex-start' }}>{pending ? 'Saving…' : 'Save details'}</button>
    </form>
  );
}

export function ImportForm() {
  const [state, action, pending] = useActionState<Result, FormData>(importBrandPack, null);
  return (
    <form action={action} className="form-card">
      <h2>Import a brand pack</h2>
      <p className="muted">A design-system <code>tokens.json</code> (color.tokens list, optional type.families and type.fonts), its README and woff2 fonts. Fonts are stored in your database, never in the repo.</p>
      <div><label htmlFor="i-tokens">tokens.json</label><input id="i-tokens" name="tokens" type="file" accept=".json,application/json" required /></div>
      <div><label htmlFor="i-readme">README.md (optional)</label><input id="i-readme" name="readme" type="file" accept=".md,text/markdown,text/plain" /></div>
      <div><label htmlFor="i-fonts">Font files (optional, woff2)</label><input id="i-fonts" name="fonts" type="file" accept=".woff2,.woff" multiple /></div>
      <Status s={state} />
      <button className="btn" disabled={pending} style={{ alignSelf: 'flex-start' }}>{pending ? 'Importing…' : 'Import'}</button>
    </form>
  );
}
