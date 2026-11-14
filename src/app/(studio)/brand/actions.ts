'use server';
import { revalidatePath } from 'next/cache';
import { getBrand, resetBrand, saveBrand, ROLES, type BrandPack } from '@/lib/brand';

const WEIGHTS: Record<string, string> = { thin: '100', extralight: '200', light: '300', regular: '400', book: '400', medium: '500', semibold: '600', bold: '700', extrabold: '800', black: '900' };

export async function updateBrandDetails(_prev: unknown, formData: FormData) {
  const cur = await getBrand();
  let roles = cur.roles;
  const rolesText = String(formData.get('roles') || '').trim();
  if (rolesText) {
    try {
      const parsed = JSON.parse(rolesText) as Record<string, string>;
      const bad = Object.keys(parsed).filter(k => !(ROLES as readonly string[]).includes(k));
      if (bad.length) return { error: `Unknown roles: ${bad.join(', ')}` };
      roles = parsed;
    } catch { return { error: 'Roles must be valid JSON, e.g. {"primary": "brand-green"}' }; }
  }
  await saveBrand({
    ...cur,
    name: String(formData.get('name') || cur.name).trim(),
    handle: String(formData.get('handle') || cur.handle).trim(),
    labelPrefix: String(formData.get('labelPrefix') || cur.labelPrefix).trim(),
    readme: String(formData.get('readme') ?? cur.readme),
    roles,
  });
  revalidatePath('/', 'layout');
  return { ok: 'Saved. New renders use these settings.' };
}

/** Upload tokens.json (+ fonts). Font family/weight come from tokens.type.fonts, else from the filename (Family-Bold.woff2). */
export async function importBrandPack(_prev: unknown, formData: FormData) {
  const tokensFile = formData.get('tokens') as File | null;
  if (!tokensFile || !tokensFile.size) return { error: 'Choose a tokens.json file.' };
  let tokens: BrandPack['tokens'] & { type?: { fonts?: { family: string; file: string; weight: string }[] } };
  try { tokens = JSON.parse(await tokensFile.text()); } catch { return { error: 'tokens.json is not valid JSON.' }; }
  if (!Array.isArray(tokens?.color?.tokens)) return { error: 'tokens.json needs color.tokens: [{ name, value }]' };

  const fonts: BrandPack['fonts'] = [];
  for (const f of formData.getAll('fonts') as File[]) {
    if (!f.size || !/\.woff2?$/i.test(f.name)) continue;
    const listed = tokens.type?.fonts?.find(x => x.file.split('/').pop() === f.name);
    const m = /^(.+?)[-_ ]?(thin|extralight|light|regular|book|medium|semibold|bold|extrabold|black|\d{3})?\.woff2?$/i.exec(f.name);
    fonts.push({
      family: listed?.family ?? m?.[1].replace(/([a-z])([A-Z])/g, '$1 $2') ?? f.name,
      weight: String(listed?.weight ?? (m?.[2] ? (WEIGHTS[m[2].toLowerCase()] ?? m[2]) : '400')),
      data: Buffer.from(await f.arrayBuffer()).toString('base64'),
    });
  }
  const readmeFile = formData.get('readme') as File | null;
  const cur = await getBrand();
  await saveBrand({
    ...cur,
    name: (tokens as { name?: string }).name ?? cur.name,
    tokens,
    fonts: fonts.length ? fonts : cur.fonts,
    readme: readmeFile?.size ? await readmeFile.text() : cur.readme,
  });
  revalidatePath('/', 'layout');
  return { ok: `Imported ${tokens.color.tokens.length} colors and ${fonts.length || 'no new'} fonts. Map roles below if your token names differ.` };
}

export async function resetToDefault() {
  await resetBrand();
  revalidatePath('/', 'layout');
}
