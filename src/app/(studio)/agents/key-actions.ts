'use server';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { getDb, schema } from '@/db';
import { newApiKey, sha256 } from '@/lib/auth';

export async function createKeyAction(_prev: unknown, formData: FormData) {
  const name = String(formData.get('name') || '').trim().slice(0, 60);
  if (!name) return null;
  const key = newApiKey();
  await getDb().insert(schema.apiKeys).values({ name, hash: await sha256(key) });
  revalidatePath('/agents');
  return { name, key };
}

export async function revokeKey(id: string) {
  await getDb().delete(schema.apiKeys).where(eq(schema.apiKeys.id, id));
  revalidatePath('/agents');
}
