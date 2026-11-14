import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

export const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

/** Agent API keys: stored as sha256 hashes. Returns the agent name or null. */
export async function verifyApiKey(token: string | undefined) {
  if (!token?.startsWith('ks_')) return null;
  const db = getDb();
  const [k] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.hash, await sha256(token)));
  if (!k) return null;
  await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, k.id));
  return k.name;
}

export function newApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'ks_' + Buffer.from(bytes).toString('base64url');
}

// ---------- browser session for the studio UI (single owner, password) ----------

export const SESSION_COOKIE = 'studio_session';
const SESSION_DAYS = 30;

async function hmac(data: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(process.env.STUDIO_SESSION_SECRET ?? ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function makeSession() {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  return `${exp}.${await hmac(String(exp))}`;
}

export async function validSession(value: string | undefined) {
  if (!value || !process.env.STUDIO_SESSION_SECRET) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  return sig === (await hmac(exp));
}

export const sessionMaxAge = SESSION_DAYS * 86_400;
