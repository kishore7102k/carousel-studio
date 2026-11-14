// Render check for the four template slides.
//   npx tsx scripts/render-check.ts <outDir>        render the sample carousel to PNGs
//   npx tsx scripts/render-check.ts --snapshot      record HTML + PNG hashes in scripts/render-snapshots.json
//   npx tsx scripts/render-check.ts --check         fail if the template HTML changed (PNG hash compared too)
// The HTML hash is the contract ("templates byte-identical"); PNG hashes depend on the local browser build,
// so a PNG mismatch alone is reported as a warning.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderPngs } from '@/lib/render/render';
import { slideHtml } from '@/lib/render/html';
import { Slides } from '@/lib/slides';
import { DEFAULT_PACK } from '@/brand/default-pack';

const slides = Slides.parse([
  { kind: 'cover', hook: 'Stop installing *date picker* libraries.', sub: 'Your browser already ships one.' },
  { kind: 'content', title: 'Why it beats a *library*', points: ['Native picker on every phone', 'Keyboard and screen reader ready', 'Ships zero JavaScript', 'Set limits with `min` and `max`'] },
  { kind: 'code', file: 'date-input.html', diff: true, code: '- npm install react-datepicker\n\n+ <input type="date"\n+   min="2026-01-01"\n+   max="2026-12-31">', caption: 'Native, accessible, *zero KB* added.' },
  { kind: 'cta', hook: 'Save this for your *next form*.', sub: 'One dev tip, four days a week.' },
]);
const TIP = 'Tip 014';
const SNAP = 'scripts/render-snapshots.json';
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
type Snap = Record<string, { html: string; png: string }>;

(async () => {
  const mode = process.argv[2];
  const t = Date.now();
  const pngs = await renderPngs(slides, TIP, DEFAULT_PACK);
  const now: Snap = Object.fromEntries(slides.map((s, i) => [
    `${i + 1}-${s.kind}`,
    { html: sha(slideHtml(s, i, slides.length, TIP, DEFAULT_PACK)), png: sha(pngs[i]) },
  ]));

  if (mode === '--snapshot') {
    writeFileSync(SNAP, JSON.stringify(now, null, 2) + '\n');
    console.log(`wrote ${SNAP} (${slides.length} slides, ${Date.now() - t}ms)`);
    return;
  }
  if (mode === '--check') {
    if (!existsSync(SNAP)) { console.error(`missing ${SNAP}; run --snapshot first`); process.exit(1); }
    const want = JSON.parse(readFileSync(SNAP, 'utf8')) as Snap;
    let failed = false;
    for (const [k, v] of Object.entries(want)) {
      const got = now[k];
      const htmlOk = got?.html === v.html;
      const pngOk = got?.png === v.png;
      if (!htmlOk) failed = true;
      console.log(`${htmlOk ? 'PASS' : 'FAIL'}  ${k.padEnd(10)} html ${htmlOk ? 'identical' : 'CHANGED'}, png ${pngOk ? 'identical' : 'differs (warning: browser build?)'}`);
    }
    process.exit(failed ? 1 : 0);
  }
  const out = mode ?? 'render-check';
  mkdirSync(out, { recursive: true });
  pngs.forEach((p, i) => writeFileSync(`${out}/${i + 1}.png`, p));
  console.log(`rendered ${pngs.length} slides in ${Date.now() - t}ms`);
})();
