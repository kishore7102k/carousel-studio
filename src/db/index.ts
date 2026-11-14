import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

function createDb() {
  return drizzle(neon(process.env.DATABASE_URL!), { schema });
}

let db: ReturnType<typeof createDb> | null = null;

// Lazy so `next build` works before env vars exist.
export function getDb() {
  if (!db) db = createDb();
  return db;
}

export { schema };
