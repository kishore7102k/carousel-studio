// The brand layer: everything a slide gets from the brand regardless of its layout.
// Fonts, role colors, spacing/radius/type-scale variables, brand utility classes and the studio chrome.
// Templates (html.ts) use brandCss() + their own BASE; design slides use brandCss() + designLayerCss().
// brandCss() and foot() feed the template HTML: their output must stay byte-identical (scripts/render-check.ts).
import { family, roleColor, type BrandPack, type Role } from '@/lib/brand';
import type { Chrome } from '@/lib/slides';
import { highlight } from './highlight';

export const W = 1080;
export const H = 1350;
/** Lint safe area: content should stay this far from every edge. */
export const SAFE = 64;
/** Slide margin used by the templates and the default design padding (space-9). */
export const MARGIN = 96;

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Escape, then `code` → <code>, *phrase* → <mark>. */
export function inline(s: string) {
  const codes: string[] = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out.replace(/\*([^*]+)\*/g, '<mark>$1</mark>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

// ---------- colors ----------

/** CSS variable → brand role. Order matters: it is the template :root order. */
export const VARS: [string, Role, string][] = [
  ['paper', 'paper', 'Light slide ground'],
  ['ink', 'ink', 'Text on paper'],
  ['muted', 'ink-muted', 'Secondary text on paper (captions, metadata, chrome)'],
  ['line', 'line', 'Hairline borders and dividers on paper'],
  ['primary', 'primary', 'The brand color: ground of covers, CTAs and big brand fields'],
  ['on-primary', 'on-primary', 'Text and marks on primary'],
  ['bright', 'primary-bright', 'Accent that reads on dark grounds (primary, code-bg): live dot, small accents. Never text on paper'],
  ['marker', 'marker', 'The highlighter behind ONE phrase per slide (use <mark>)'],
  ['on-marker', 'on-marker', 'Text on the marker'],
  ['code-bg', 'code-bg', 'Ground of code blocks and dark slides'],
  ['code-line', 'code-line', 'Border of code blocks'],
  ['code-text', 'code-text', 'Plain code text on code-bg'],
  ['kw', 'syntax-keyword', 'Code keywords'],
  ['str', 'syntax-string', 'Code strings and numbers'],
  ['tag', 'syntax-tag', 'Code tags, types, function names'],
  ['cm', 'syntax-comment', 'Code comments, removed diff lines'],
  ['add', 'diff-add', 'Background of added diff rows'],
  ['rm', 'diff-remove', 'Background of removed diff rows'],
  ['accent', 'accent', 'Accent on paper: links, the live dot on paper, small emphasis'],
];

type ColorToken = BrandPack['tokens']['color']['tokens'][number];
const firstTheme = (b: BrandPack) => b.tokens.color.themes?.[0]?.id ?? 'light';

/** A color token's value in the first theme, following {alias} references. */
export function tokenColor(b: BrandPack, name: string, depth = 0): string | undefined {
  const t: ColorToken | undefined = b.tokens.color.tokens.find(c => c.name === name);
  if (!t || depth > 8) return undefined;
  const v = typeof t.value === 'string' ? t.value : (t.value[firstTheme(b)] ?? Object.values(t.value)[0]);
  const alias = /^\{(.+)\}$/.exec(v);
  return alias ? tokenColor(b, alias[1], depth + 1) : v;
}

const tokenUsage = (b: BrandPack, role: Role) =>
  b.tokens.color.tokens.find(c => c.name === (b.roles[role] ?? role))?.usage;

/** Every color the brand allows (first theme): all color tokens + all roles. Lint compares computed colors with this. */
export function brandPalette(b: BrandPack): string[] {
  const all = [
    ...b.tokens.color.tokens.map(t => tokenColor(b, t.name)),
    ...VARS.map(([, r]) => roleColor(b, r)),
  ].filter((v): v is string => !!v);
  return [...new Set(all.map(v => v.trim().toLowerCase()))];
}

// ---------- template brand CSS (byte-identical contract) ----------

const fontFaces = (b: BrandPack) =>
  b.fonts.map(f => `@font-face{font-family:'${f.family}';font-weight:${f.weight};src:url(data:font/woff2;base64,${f.data}) format('woff2')}`).join('');

/** @font-face rules + the :root role variables. Slides are images: the brand's first theme is always used. */
export function brandCss(b: BrandPack) {
  const vars = VARS.map(([v, r]) => `--${v}:${roleColor(b, r)}`).join(';');
  return `${fontFaces(b)}:root{${vars};--sans:${family(b, 'sans')};--mono:${family(b, 'mono')}}`;
}

/** Template footer: live dot + handle on the left, `right` (counter or "Swipe") on the right. */
export const foot = (counter: string, handle: string) =>
  `<div class="foot mono"><span><span class="dot"></span>${esc(handle)}</span><span>${counter}</span></div>`;

/** Editor rows with syntax highlighting; diff: lines starting "- " / "+ " become removed / added rows. */
export function codeRows(code: string, diff: boolean) {
  return code.split('\n').map(line => {
    let cls = 'r', gutter = '';
    if (diff && /^[-+] ?/.test(line)) {
      cls += line[0] === '-' ? ' rm' : ' add';
      gutter = `<span class="g">${line[0]} </span>`;
      line = line.replace(/^[-+] ?/, '');
    } else if (diff) gutter = '<span class="g">  </span>';
    const body = highlight(line);
    return `<span class="${cls}">${gutter}${cls.includes('rm') ? `<span class="t">${body}</span>` : body}</span>`;
  }).join('');
}

// ---------- design layer: tokens ----------

type Tok = { name: string; value: string; usage?: string };
const SAFE_NAME = /^[a-z][a-z0-9-]{0,40}$/i;
const SAFE_LEN = /^-?\d+(\.\d+)?(px|em|rem|%)?$/;

const DEFAULT_SPACING: Tok[] = [
  ['space-1', '4px'], ['space-2', '8px'], ['space-3', '12px'], ['space-4', '16px'], ['space-5', '24px'],
  ['space-6', '32px'], ['space-7', '48px'], ['space-8', '64px'], ['space-9', '96px'],
].map(([name, value]) => ({ name, value }));
const DEFAULT_RADII: Tok[] = [['radius-sm', '6px'], ['radius-md', '10px'], ['radius-lg', '16px'], ['radius-pill', '999px']].map(([name, value]) => ({ name, value }));

function tokenGroup(b: BrandPack, key: 'spacing' | 'radius', fallback: Tok[]): Tok[] {
  const raw = (b.tokens as Record<string, unknown>)[key] as { tokens?: unknown } | undefined;
  const list = Array.isArray(raw?.tokens) ? (raw!.tokens as Tok[]).filter(t => typeof t?.name === 'string' && SAFE_NAME.test(t.name) && typeof t.value === 'string' && SAFE_LEN.test(t.value)) : [];
  return list.length ? list : fallback;
}

/** Design-only variables beyond the role colors. */
export const designVars = (b: BrandPack) => ({
  surface: tokenColor(b, 'surface') ?? roleColor(b, 'paper'),
  spacing: tokenGroup(b, 'spacing', DEFAULT_SPACING),
  radii: tokenGroup(b, 'radius', DEFAULT_RADII),
});

export type TypeStyle = { name: string; size: string; lineHeight: string; weight: string; tracking: string; family: 'sans' | 'mono'; use: string };

// Slide type scale (1080 canvas). Defaults are the template values; a pack's "slide-*" styles override them.
const TYPE_DEFAULTS: TypeStyle[] = [
  { name: 'hook', size: '112px', lineHeight: '1', weight: '700', tracking: '-0.035em', family: 'sans', use: 'Cover hook / the one big statement. Max 4 lines.' },
  { name: 'title', size: '72px', lineHeight: '1.05', weight: '700', tracking: '-0.03em', family: 'sans', use: 'Slide headline. Max 3 lines.' },
  { name: 'caption', size: '64px', lineHeight: '1.08', weight: '700', tracking: '-0.03em', family: 'sans', use: 'Bold caption under a code block or diagram.' },
  { name: 'body', size: '42px', lineHeight: '1.4', weight: '500', tracking: '0', family: 'sans', use: 'Body text and list points. About 25 words per slide.' },
  { name: 'code', size: '36px', lineHeight: '1.5', weight: '400', tracking: '0', family: 'mono', use: 'Code. Max 32 characters per line.' },
  { name: 'label', size: '30px', lineHeight: '1.2', weight: '500', tracking: '0', family: 'mono', use: 'Keycap label, chips, counters, small technical labels.' },
];

export function typeScale(b: BrandPack): TypeStyle[] {
  const groups = ((b.tokens.type as Record<string, unknown> | undefined)?.groups ?? []) as { styles?: Record<string, unknown>[] }[];
  const styles = Array.isArray(groups) ? groups.flatMap(g => (Array.isArray(g?.styles) ? g.styles : [])) : [];
  return TYPE_DEFAULTS.map(d => {
    const s = styles.find(x => x?.name === `slide-${d.name}`);
    if (!s) return d;
    const str = (v: unknown, ok: RegExp, dflt: string) => (v != null && ok.test(String(v)) ? String(v) : dflt);
    return {
      ...d,
      size: str(s.fontSize, /^\d+(\.\d+)?px$/, d.size),
      lineHeight: str(s.lineHeight, /^\d+(\.\d+)?$/, d.lineHeight),
      weight: str(s.fontWeight, /^\d{3}$/, d.weight),
      tracking: str(s.letterSpacing, /^-?\d*(\.\d+)?(em|px)?$/, d.tracking),
      use: typeof s.usage === 'string' ? s.usage : d.use,
    };
  });
}

// ---------- design layer: CSS ----------

const CHROME_H = 36; // 30px mono label at line-height 1.2
/** Bottom padding of a design slide when the studio draws the footer chrome (same as the templates: footer + 64px gap). */
export const FOOT_PAD = MARGIN + CHROME_H + 64;

const DESIGN_BASE = `
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:var(--sans);-webkit-font-smoothing:antialiased;background:var(--paper)}
.slide.design{position:relative;width:${W}px;height:${H}px;padding:${MARGIN}px;display:flex;flex-direction:column;overflow:hidden;isolation:isolate;contain:paint;font-weight:500;font-size:var(--fs-body);line-height:1.4}
.slide.design.with-foot{padding-bottom:${FOOT_PAD}px}
.paper{background:var(--paper);color:var(--ink)}
.surface{background:var(--surface);color:var(--ink)}
.primary{background:var(--primary);color:var(--on-primary)}
.dark{background:var(--code-bg);color:var(--code-text)}
.muted{color:var(--muted)}
.primary .muted,.dark .muted{color:inherit;opacity:.8}
.mono{font-family:var(--mono);font-weight:500}
.key{display:inline-block;align-self:flex-start;font-family:var(--mono);font-weight:500;font-size:var(--fs-label);line-height:1.2;padding:10px 24px;border-radius:12px;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-bottom-width:10px}
.chip{display:inline-flex;align-items:center;gap:12px;align-self:flex-start;font-family:var(--mono);font-weight:500;font-size:var(--fs-label);line-height:1.2;padding:8px 22px;border-radius:999px;border:1px solid var(--line)}
.primary .chip,.dark .chip{border-color:color-mix(in srgb,currentColor 35%,transparent)}
.dot{display:inline-block;width:16px;height:16px;border-radius:999px;background:var(--bright);margin-right:14px;vertical-align:2px}
.paper .dot,.surface .dot{background:var(--accent)}
mark{color:var(--on-marker);background:linear-gradient(var(--marker),var(--marker)) 0 62%/100% 74% no-repeat;padding:0 .1em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
code{font-family:var(--mono);font-size:.86em;background:var(--code-bg);color:var(--code-text);padding:0 .3em;border-radius:10px}
.editor{display:block;background:var(--code-bg);border:1px solid var(--code-line);border-radius:32px;padding:40px 0;font-family:var(--mono);font-weight:400;font-size:var(--fs-code);line-height:1.5;color:var(--code-text)}
pre.editor{white-space:pre;padding:40px}
.editor code{background:none;padding:0;font-size:1em;color:inherit;border-radius:0}
.editor .r{display:block;white-space:pre;padding:0 40px;min-height:1.5em}
.editor .g{color:var(--cm)} .editor .k{color:var(--kw)} .editor .s{color:var(--str)} .editor .tg{color:var(--tag)} .editor .c{color:var(--cm)}
.editor .rm{background:var(--rm);color:var(--cm)} .editor .rm .t{text-decoration:line-through;text-decoration-color:var(--cm)}
.editor .rm .k,.editor .rm .s,.editor .rm .g,.editor .rm .c,.editor .rm .tg{color:var(--cm)}
.editor .add{background:var(--add);box-shadow:inset 16px 0 0 var(--bright)}
.card{background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:32px;padding:48px}
.primary .card{background:color-mix(in srgb,var(--on-primary) 8%,transparent);border-color:color-mix(in srgb,var(--on-primary) 24%,transparent);color:var(--on-primary)}
.dark .card{background:color-mix(in srgb,var(--code-text) 6%,transparent);border-color:var(--code-line);color:var(--code-text)}
.card.paper{background:var(--paper);color:var(--ink);border-color:var(--line)}
.card.primary{background:var(--primary);color:var(--on-primary);border-color:transparent}
.card.dark{background:var(--code-bg);color:var(--code-text);border-color:var(--code-line)}
.rows{list-style:none;padding:0}
.rows>*{padding:24px 0;border-top:1px solid var(--line)}
.primary .rows>*,.dark .rows>*{border-top-color:color-mix(in srgb,currentColor 24%,transparent)}
.rule{border:0;border-top:1px solid var(--line)}
.stack{display:flex;flex-direction:column;gap:var(--space-6)}
.row{display:flex;align-items:center;gap:var(--space-6)}
.grow{flex:1}
.push{margin-top:auto}
.chrome{position:absolute;left:${MARGIN}px;right:${MARGIN}px;bottom:${MARGIN}px;z-index:1;display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-weight:500;font-size:30px;line-height:1.2;pointer-events:none}
.chrome.on-paper{color:var(--muted)}
.chrome.on-primary{color:var(--on-primary);opacity:.8}
.chrome.on-dark{color:var(--code-text);opacity:.8}
.chrome .dot{background:var(--bright)}
.chrome.on-paper .dot{background:var(--accent)}
`;

/** Extra :root variables for design slides (spacing, radii, type scale, surface) + the design reset and utility classes. */
export function designLayerCss(b: BrandPack) {
  const d = designVars(b);
  const vars = [
    `--surface:${d.surface}`,
    ...d.spacing.map(t => `--${t.name}:${t.value}`),
    ...d.radii.map(t => `--${t.name}:${t.value}`),
    ...typeScale(b).map(t => `--fs-${t.name}:${t.size}`),
  ].join(';');
  const type = typeScale(b).map(t =>
    `.t-${t.name}{font-family:var(--${t.family});font-size:var(--fs-${t.name});line-height:${t.lineHeight};font-weight:${t.weight};letter-spacing:${t.tracking}${t.family === 'sans' && +t.weight >= 700 ? ';text-wrap:balance' : ''}}`).join('\n');
  return `:root{${vars}}${DESIGN_BASE}${type}\n`;
}

/** Grounds a design slide can sit on (the section class); chrome colors follow it. */
export const GROUNDS = ['paper', 'primary', 'dark'] as const;
export type Ground = (typeof GROUNDS)[number];

/** The studio chrome of a design slide. Drawn OUTSIDE the agent's section, so agent CSS cannot reach it. */
export function chromeHtml(chrome: Chrome, ground: Ground, n: number, total: number, handle: string) {
  if (chrome === 'none') return '';
  const left = chrome === 'counter' ? '' : `<span class="dot"></span>${esc(handle)}`;
  const right = chrome === 'handle' ? '' : `${n} / ${total}`;
  return `<footer class="chrome on-${ground}"><span>${left}</span><span>${right}</span></footer>`;
}

// ---------- the brand layer as data ----------

export const CLASSES: { name: string; example: string; use: string }[] = [
  { name: '.paper / .primary / .dark / .surface', example: '<div class="card primary">…</div>', use: 'Grounds: background + matching text color. The whole slide ground is the "ground" option (paper default)' },
  { name: '.t-hook .t-title .t-caption .t-body .t-code .t-label', example: '<h1 class="t-hook">Ship <mark>less</mark> JS</h1>', use: 'Type scale (font, size, weight, line height, tracking)' },
  { name: 'mark', example: '<mark>one phrase</mark>', use: 'The brand marker. ONE per slide, on the key phrase' },
  { name: '.key', example: '<span class="key">Tip 014</span>', use: 'Keycap label (mono, thick bottom edge), top-left of covers' },
  { name: '.chip', example: '<span class="chip">Before</span>', use: 'Small pill label for tags, steps, before/after' },
  { name: '.dot', example: '<span class="dot"></span>@handle', use: 'Live dot before the handle (bright on dark grounds, accent on paper)' },
  { name: 'code', example: '<code>min</code>', use: 'Inline code' },
  { name: 'pre.editor (+ .diff)', example: '<pre class="editor diff">- old()\n+ next()</pre>', use: 'Code card; plain text inside is syntax-highlighted by the studio. With .diff, lines starting "- " / "+ " become removed / added rows' },
  { name: '.editor .r .k .s .tg .c .rm .add', example: '<div class="editor"><span class="r"><span class="k">const</span> a = <span class="s">1</span></span></div>', use: 'Hand-built code card: .r = one row, .k keyword, .s string, .tg tag, .c comment, .rm / .add diff rows' },
  { name: '.card', example: '<div class="card">…</div>', use: 'Raised panel with hairline border and 32px radius (adapts on .primary / .dark)' },
  { name: '.rows', example: '<ul class="rows"><li>Point</li><li>Point</li></ul>', use: 'List with hairline dividers between rows (the content template list)' },
  { name: '.rule', example: '<hr class="rule">', use: 'Hairline divider' },
  { name: '.muted', example: '<p class="muted">Source: MDN</p>', use: 'Secondary text' },
  { name: '.mono', example: '<span class="mono">npm i</span>', use: 'Mono font (code and labels only)' },
  { name: '.stack / .row / .grow / .push', example: '<div class="row"><div class="grow">…</div></div>', use: 'Flex helpers: column with gap, row with gap, fill space, push to bottom (margin-top:auto)' },
];

export const CHROME_DOC = [
  'auto: live dot + handle bottom-left, "n / total" bottom-right (default, like the templates)',
  'handle: only the handle',
  'counter: only "n / total"',
  'none: nothing (draw your own or go full-bleed)',
];

export const DESIGN_RULES = [
  `Canvas ${W}x${H}px. The slide root is <section class="slide design {ground}">: position:relative, padding ${MARGIN}px, flex column, overflow hidden. Your html goes inside it.`,
  `With chrome auto/handle/counter the studio draws the footer at the bottom (${MARGIN}px inset) and the slide gets padding-bottom ${FOOT_PAD}px so flow content stays clear of it.`,
  'Your css is scoped to the slide: every selector is prefixed with the slide root. Target the root itself with &, :root, html, body or .slide (e.g. "&{padding:64px}").',
  'No JavaScript; all network is blocked except data: URIs and uploaded assets (upload_asset). <script>, <iframe>, <object>, <embed>, <link>, <meta>, <base>, <form>, on* attributes, javascript: URLs, remote url() and @import are removed.',
  `Error (saving refused): text or images outside the ${W}x${H} canvas.`,
  `Warnings: content outside the ${SAFE}px safe area, text clipped by its container, text overlapping the footer chrome, text under 24px, non-brand fonts, colors outside the brand palette, more than one <mark>, text contrast below WCAG AA (4.5:1; 3:1 for text >= 64px or bold >= 48px).`,
];
