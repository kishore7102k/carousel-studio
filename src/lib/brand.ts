import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { DEFAULT_PACK } from '@/brand/default-pack';

/** Roles the slide templates paint with. Each maps to a color token name in the pack (default: same name). */
export const ROLES = ['primary', 'on-primary', 'primary-bright', 'paper', 'ink', 'ink-muted', 'line', 'accent', 'marker', 'on-marker', 'code-bg', 'code-line', 'code-text', 'syntax-keyword', 'syntax-string', 'syntax-tag', 'syntax-comment', 'diff-add', 'diff-remove'] as const;
export type Role = (typeof ROLES)[number];

type ColorToken = { name: string; value: string | Record<string, string>; usage?: string };
export type BrandPack = {
  name: string;
  handle: string;
  labelPrefix: string;
  readme: string;
  tokens: { name?: string; color: { themes?: { id: string; name?: string }[]; tokens: ColorToken[] }; type?: { families?: Record<string, string> } & Record<string, unknown> } & Record<string, unknown>;
  fonts: { family: string; weight: string; data: string }[];
  roles: Partial<Record<Role, string>>;
};

let cache: { pack: BrandPack; at: number } | null = null;
const TTL = 30_000;

/** The active brand: the one saved in the database, else the bundled default (OFL fonts). */
export async function getBrand(): Promise<BrandPack> {
  if (cache && Date.now() - cache.at < TTL) return cache.pack;
  const [row] = await getDb().select().from(schema.brand).where(eq(schema.brand.id, 'default'));
  const pack = row ? (row.pack as BrandPack) : DEFAULT_PACK;
  cache = { pack, at: Date.now() };
  return pack;
}

export async function saveBrand(pack: BrandPack) {
  await getDb().insert(schema.brand).values({ id: 'default', pack, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.brand.id, set: { pack, updatedAt: new Date() } });
  cache = null;
}

export async function resetBrand() {
  await getDb().delete(schema.brand).where(eq(schema.brand.id, 'default'));
  cache = null;
}

/** Resolves a role to a hex/rgb value (first theme), following {alias} references. */
export function roleColor(pack: BrandPack, role: Role): string {
  const lookup = (name: string, depth = 0): string | undefined => {
    const t = pack.tokens.color.tokens.find(c => c.name === name);
    if (!t || depth > 8) return undefined;
    const first = pack.tokens.color.themes?.[0]?.id ?? 'light';
    const v = typeof t.value === 'string' ? t.value : (t.value[first] ?? Object.values(t.value)[0]);
    const alias = /^\{(.+)\}$/.exec(v);
    return alias ? lookup(alias[1], depth + 1) : v;
  };
  return lookup(pack.roles[role] ?? role) ?? lookup(role) ?? fallback(role);
}

function fallback(role: Role): string {
  const t = DEFAULT_PACK.tokens.color.tokens.find(c => c.name === role);
  return typeof t?.value === 'string' ? t.value : '#888888';
}

export const family = (pack: BrandPack, key: 'sans' | 'mono') =>
  pack.tokens.type?.families?.[key] ?? DEFAULT_PACK.tokens.type!.families![key];

export const tipLabel = (pack: BrandPack, n: number | null) => (n ? `${pack.labelPrefix} ${String(n).padStart(3, '0')}` : pack.labelPrefix);
