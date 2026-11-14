// Smoke check: renders the sample carousel to PNGs locally.  npx tsx scripts/render-check.ts <outDir>
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderPngs } from '@/lib/render/render';
import { Slides } from '@/lib/slides';
import { DEFAULT_PACK } from '@/brand/default-pack';

const slides = Slides.parse([
  { kind: 'cover', hook: 'Stop installing *date picker* libraries.', sub: 'Your browser already ships one.' },
  { kind: 'content', title: 'Why it beats a *library*', points: ['Native picker on every phone', 'Keyboard and screen reader ready', 'Ships zero JavaScript', 'Set limits with `min` and `max`'] },
  { kind: 'code', file: 'date-input.html', diff: true, code: '- npm install react-datepicker\n\n+ <input type="date"\n+   min="2026-01-01"\n+   max="2026-12-31">', caption: 'Native, accessible, *zero KB* added.' },
  { kind: 'cta', hook: 'Save this for your *next form*.', sub: 'One dev tip, four days a week.' },
]);
const out = process.argv[2] ?? 'render-check';
mkdirSync(out, { recursive: true });
(async () => {
const t = Date.now();
const pngs = await renderPngs(slides, 'Tip 014', DEFAULT_PACK);
pngs.forEach((p, i) => writeFileSync(`${out}/${i + 1}.png`, p));
console.log(`rendered ${pngs.length} slides in ${Date.now() - t}ms`);
})();
