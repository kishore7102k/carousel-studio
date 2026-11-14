import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

export const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

export type Scope = 'read' | 'write' | 'admin';
export type ApiKeyScopes = Scope[];

/** Agent API keys: stored as sha256 hashes. Returns the agent identity or null. */
export async function verifyApiKey(token: string | undefined) {
  if (!token?.startsWith('ks_')) return null;
  const db = getDb();
  const [k] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.hash, await sha256(token)));
  if (!k) return null;
  await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, k.id));
  return { id: k.id, name: k.name, scopes: (k.scopes ?? ['read', 'write']) as ApiKeyScopes };
}

export function newApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'ks_' + Buffer.from(bytes).toString('base64url');
}

/** Expands the hierarchy: admin -> read,write,admin; write -> read,write. */
export function normalizeScopes(scopes: Scope[]): Scope[] {
  const out = new Set<Scope>();
  for (const s of scopes) {
    out.add('read');
    if (s === 'write' || s === 'admin') out.add('write');
    if (s === 'admin') out.add('admin');
  }
  return (['read', 'write', 'admin'] as const).filter(s => out.has(s));
}

/** Creates a key. The plaintext is returned once; only its sha256 is stored. */
export async function createKey(name: string, scopes: Scope[]): Promise<{ id: string; name: string; scopes: Scope[]; key: string }> {
  const key = newApiKey();
  const norm = normalizeScopes(scopes.length ? scopes : ['read']);
  const [row] = await getDb().insert(schema.apiKeys).values({ name: name.trim(), hash: await sha256(key), scopes: norm }).returning();
  return { id: row.id, name: row.name, scopes: norm, key };
}

/** Never returns hashes. Newest first. */
export async function listKeys() {
  const rows = await getDb().select().from(schema.apiKeys).orderBy(desc(schema.apiKeys.createdAt));
  return rows.map(k => ({ id: k.id, name: k.name, scopes: (k.scopes ?? ['read', 'write']) as Scope[], createdAt: k.createdAt, lastUsedAt: k.lastUsedAt }));
}

export async function revokeKey(id: string): Promise<boolean> {
  const rows = await getDb().delete(schema.apiKeys).where(eq(schema.apiKeys.id, id)).returning({ id: schema.apiKeys.id });
  return rows.length > 0;
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
