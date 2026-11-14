'use server';
import { revalidatePath } from 'next/cache';
import { createKey, revokeKey as revoke, normalizeScopes, type Scope } from '@/lib/auth';
import { logActivity } from '@/lib/store';

export async function createKeyAction(_prev: unknown, formData: FormData) {
  const name = String(formData.get('name') || '').trim().slice(0, 60);
  if (!name) return null;
  const level = String(formData.get('scope') || 'write');
  const scopes = normalizeScopes([(['read', 'write', 'admin'].includes(level) ? level : 'write') as Scope]);
  const created = await createKey(name, scopes);
  await logActivity('you', 'create_key', null, { name, scopes });
  revalidatePath('/agents');
  return { name, key: created.key, scopes };
}

export async function revokeKey(id: string) {
  await revoke(id);
  await logActivity('you', 'revoke_access', null, { id });
  revalidatePath('/agents');
}
