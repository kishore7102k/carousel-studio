import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, makeSession, sessionMaxAge } from '@/lib/auth';

export const metadata = { title: 'Sign in' };

async function login(formData: FormData) {
  'use server';
  const next = String(formData.get('next') || '/');
  if (!process.env.STUDIO_PASSWORD || formData.get('password') !== process.env.STUDIO_PASSWORD) redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  (await cookies()).set(SESSION_COOKIE, await makeSession(), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: sessionMaxAge, path: '/' });
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  return (
    <main className="login">
      <form action={login} className="login-card">
        <span className="product" style={{ padding: 0 }}><span className="logo" aria-hidden="true"><i /><i /><i /></span><span>Carousel Studio</span></span>
        <h1>Sign in</h1>
        <div>
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoFocus required autoComplete="current-password" />
        </div>
        <input type="hidden" name="next" value={next ?? '/'} />
        {error && <p className="error" role="alert">Wrong password. Try again.</p>}
        <button type="submit" className="btn primary" style={{ justifyContent: 'center' }}>Sign in</button>
      </form>
    </main>
  );
}
