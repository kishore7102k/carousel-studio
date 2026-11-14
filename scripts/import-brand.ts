// Imports a design-system folder (tokens.json, README.md, fonts/) into the database as the active brand.
// Licensed fonts stay in your private database, never in the repo.
//   npm run brand:import -- <dir> --name "My Brand" --handle "@me" --label "Tip" --roles '{"primary":"brand-green"}'
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { saveBrand, type BrandPack } from '@/lib/brand';

const args = process.argv.slice(2);
const dir = args[0];
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : undefined; };
if (!dir || !existsSync(join(dir, 'tokens.json'))) { console.error('usage: npm run brand:import -- <dir with tokens.json> [--name] [--handle] [--label] [--roles json]'); process.exit(1); }

const tokens = JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8'));
let readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';
const comps = join(dir, 'components');
if (existsSync(comps)) {
  for (const d of readdirSync(comps)) {
    const f = join(comps, d, 'README.md');
    if (existsSync(f)) readme += `\n\n## Template: ${d}\n\n${readFileSync(f, 'utf8').replace(/^# .*\n/, '')}`;
  }
}
const fonts = ((tokens.type?.fonts ?? []) as { family: string; weight: string; file: string }[])
  .filter(f => /\.woff2?$/.test(f.file) && existsSync(join(dir, f.file)))
  .map(f => ({ family: f.family, weight: String(f.weight), data: readFileSync(join(dir, f.file)).toString('base64') }));

const pack: BrandPack = {
  name: opt('name') ?? tokens.name ?? 'My brand',
  handle: opt('handle') ?? '@yourhandle',
  labelPrefix: opt('label') ?? 'Tip',
  readme,
  tokens,
  fonts,
  roles: JSON.parse(opt('roles') ?? '{}'),
};

(async () => {
  await saveBrand(pack);
  console.log(`imported "${pack.name}": ${tokens.color.tokens.length} colors, ${fonts.length} fonts, roles ${JSON.stringify(pack.roles)}`);
})();
