import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, validSession } from '@/lib/auth';
import {
  authorizationResponseUrl, authorizeQuery, clientSource, createAuthorizationCode, pickAuthorizeParams, signConsent,
  validateAuthorize, verifyConsent, AUTHORIZE_PARAMS,
} from '@/lib/oauth/consent';
import { SCOPES, type Scope } from '@/lib/oauth/core';

export const metadata = { title: 'Authorize app' };

const SCOPE_TEXT: Record<Scope, string> = {
  read: 'See carousels, slides, notes, brand and activity',
  write: 'Create and edit carousels, slides and notes',
  admin: 'Change the brand, manage API keys and connections, delete permanently',
};

const hasSession = async () => validSession((await cookies()).get(SESSION_COOKIE)?.value);

/** Approve or deny. Everything is re-checked: session, signature over the shown params, the params themselves. */
async function decide(formData: FormData) {
  'use server';
  // The ticked checkboxes are named `scope`; the originally requested scope travels as `requested_scope`.
  const { raw, duplicate } = pickAuthorizeParams(name =>
    formData.getAll(name === 'scope' ? 'requested_scope' : name).filter((v): v is string => typeof v === 'string'));
  const back = `/oauth/authorize?${authorizeQuery(raw)}`;

  if (!(await hasSession())) redirect(`/login?next=${encodeURIComponent(back)}`);
  // Stale or tampered form: show a fresh consent screen for these params (no code is issued).
  if (duplicate || !(await verifyConsent(raw, String(formData.get('sig') ?? '')))) redirect(back);

  const check = await validateAuthorize(raw);
  if (!check.ok) redirect('redirect' in check ? check.redirect : back);
  const req = check.req;

  if (formData.get('decision') !== 'allow') {
    redirect(authorizationResponseUrl(req.redirectUri, { error: 'access_denied', error_description: 'The owner denied access', state: req.state }));
  }
  const ticked = formData.getAll('scope').map(String);
  const granted = req.scopes.filter(s => ticked.includes(s));
  if (!granted.length) redirect(`${back}&consent_error=no_scope`);

  const code = await createAuthorizationCode(req, granted);
  redirect(authorizationResponseUrl(req.redirectUri, { code, state: req.state }));
}

function ErrorCard({ message }: { message: string }) {
  return (
    <main className="login">
      <div className="login-card" role="alert">
        <h1>Can&apos;t connect this app</h1>
        <p className="error">{message}</p>
        <p className="muted" style={{ fontSize: 13.5 }}>Nothing was shared. Close this tab and try connecting again from the app.</p>
      </div>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const all = (name: string) => { const v = sp[name]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; };

  if (!(await hasSession())) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, x);
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${q}`)}`);
  }

  const { raw, duplicate } = pickAuthorizeParams(all);
  const check = await validateAuthorize(raw, duplicate);
  if (!check.ok) {
    if ('redirect' in check) redirect(check.redirect);
    return <ErrorCard message={check.fatal} />;
  }
  const req = check.req;
  const sig = await signConsent(raw);
  const host = new URL(req.redirectUri).host;
  const noScope = sp.consent_error === 'no_scope';

  return (
    <main className="login">
      <form action={decide} className="login-card" style={{ width: 'min(440px, 100%)' }}>
        <span className="product" style={{ padding: 0 }}><span className="logo" aria-hidden="true"><i /><i /><i /></span><span>Carousel Studio</span></span>
        <h1 style={{ marginBottom: 0 }}>Connect {req.client.name}?</h1>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', margin: 0, fontSize: 13.5 }}>
          <dt className="muted">Sends you back to</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}><strong data-testid="redirect-host">{host}</strong></dd>
          <dt className="muted">Client</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{clientSource(req.client)}</dd>
        </dl>
        <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
          Only allow if you started this from <strong>{host}</strong>. The name above is chosen by the app; the host is not.
        </p>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <legend style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 4 }}>It will be able to</legend>
          {SCOPES.filter(s => req.scopes.includes(s)).map(s => (
            <label key={s} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: 0, fontWeight: 500, color: 'var(--ink)', fontSize: 13.5 }}>
              <input type="checkbox" name="scope" value={s} defaultChecked style={{ marginTop: 2 }} />
              <span><span className="chip">{s}</span> {SCOPE_TEXT[s]}</span>
            </label>
          ))}
        </fieldset>
        {noScope && <p className="error" role="alert">Keep at least one permission ticked, or press Deny.</p>}
        {AUTHORIZE_PARAMS.filter(n => n !== 'scope' && raw[n] !== undefined).map(n => <input key={n} type="hidden" name={n} value={raw[n]} />)}
        {raw.scope !== undefined && <input type="hidden" name="requested_scope" value={raw.scope} />}
        <input type="hidden" name="sig" value={sig} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="submit" name="decision" value="deny" className="btn">Deny</button>
          <button type="submit" name="decision" value="allow" className="btn primary">Allow</button>
        </div>
      </form>
    </main>
  );
}
