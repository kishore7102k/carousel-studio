// Phase 3 render API for agent-designed slides. CONTRACT STUBS: Agent A implements (items 3-5).
import { family, getBrand, roleColor, tipLabel as tipLabelOf, type BrandPack } from '@/lib/brand';
import { CHROME_DOC, CLASSES, DESIGN_RULES, designVars, esc, H, inline, SAFE, typeScale, VARS, W } from './brand-layer';
import { slideHtml } from './html';
import { renderPages } from './render';
import { sanitizeCss, sanitizeHtml, summarize } from './sanitize';
import type { DesignSlide, Slide } from '@/lib/slides';

export type { Lint } from './render';
import type { Lint } from './render';

/**
 * Strips scripts, frames, external links, on* handlers, javascript: URLs, remote url()/@import from agent HTML/CSS.
 * <style> blocks in the html are moved into css. The css is returned unscoped (the renderer scopes it to the slide).
 * `removed` lists what was taken out, for the agent (warnings, never silent).
 */
export function sanitizeDesign(input: { html: string; css?: string }): { html: string; css: string; removed: string[] } {
  const h = sanitizeHtml(input.html);
  const c = sanitizeCss([input.css ?? '', ...h.styles].filter(x => x.trim()).join('\n'));
  return { html: h.html, css: c.css, removed: summarize([...h.removed, ...c.removed]) };
}

/** Sanitizes a design slide for storage. Throws if nothing renderable is left or the css grew past the limit. */
export function cleanDesignSlide(slide: DesignSlide): { slide: DesignSlide; warnings: string[] } {
  const clean = sanitizeDesign({ html: slide.html, css: slide.css });
  if (!clean.html.trim()) throw new Error(`html is empty after sanitizing${clean.removed.length ? ` (removed: ${clean.removed.join(', ')})` : ''}`);
  if (clean.html.length > 60_000) throw new Error('html is longer than 60000 characters after sanitizing');
  if (clean.css.length > 30_000) throw new Error('css (including <style> blocks moved out of html) is longer than 30000 characters');
  const { css: _css, ...rest } = slide;
  void _css;
  return {
    slide: { ...rest, html: clean.html, ...(clean.css ? { css: clean.css } : {}) },
    warnings: clean.removed.map(r => `sanitizer removed ${r}`),
  };
}

/** Renders one slide in the locked-down browser (no JS, no network) without saving. */
export async function previewSlide(slide: Slide | DesignSlide, opts: { n?: number; total?: number; tipLabel?: string; brand?: BrandPack } = {}): Promise<{ png: Buffer } & Lint> {
  const brand = opts.brand ?? await getBrand();
  const total = Math.max(1, opts.total ?? 1);
  const n = Math.min(Math.max(1, opts.n ?? 1), total);
  let s = slide as Slide;
  let removed: string[] = [];
  if (s.kind === 'design') {
    const c = cleanDesignSlide(s);
    s = c.slide;
    removed = c.warnings;
  }
  const html = slideHtml(s, n - 1, total, opts.tipLabel ?? tipLabelOf(brand, null), brand);
  const [r] = await renderPages([{ html, lint: s.kind === 'design' }], brand);
  return { png: r.png, errors: r.lint?.errors ?? [], warnings: [...removed, ...(r.lint?.warnings ?? [])] };
}

const keyOrTip = (label: string | undefined, tipLabel: string) => esc(label || tipLabel);
const top = (left: string, counter: string) => `<div class="top mono"><span>${esc(left)}</span><span>${counter}</span></div>`;
const TOP_CSS = '.top{display:flex;justify-content:space-between;font-size:var(--fs-label);line-height:1.2;color:var(--muted)}';

/**
 * Converts any slide (template or design) into an editable design slide that renders the same.
 * Tip label, counter and handle are baked in as text (the template computes them at render time).
 */
export function templateToDesign(slide: Slide, i: number, total: number, tipLabel: string, brand: BrandPack): DesignSlide {
  const counter = `${i + 1} / ${total}`;
  const notes = (k: string) => `Converted from the ${k} template. Tip label, counter and handle are fixed text here: update them if the slide moves.`;
  switch (slide.kind) {
    case 'design':
      return structuredClone(slide);
    case 'cover':
    case 'cta':
      return {
        kind: 'design', name: slide.kind, ground: 'primary', chrome: 'auto', notes: notes(slide.kind),
        html: `<span class="key">${keyOrTip(slide.kind === 'cover' ? slide.label : undefined, tipLabel)}</span>\n<h1 class="t-hook hook">${inline(slide.hook)}</h1>${slide.sub ? `\n<p class="sub">${inline(slide.sub)}</p>` : ''}`,
        css: '.hook{margin-top:auto}\n.sub{margin-top:24px;opacity:.82}',
      };
    case 'content':
      return {
        kind: 'design', name: 'content', ground: 'paper', chrome: 'none', notes: notes('content'),
        html: [
          top(tipLabel, counter),
          `<h2 class="t-title title">${inline(slide.title)}</h2>`,
          slide.points?.length ? `<ul class="rows">${slide.points.map(p => `<li>${inline(p)}</li>`).join('')}</ul>` : '',
          slide.body ? `<p class="body">${inline(slide.body)}</p>` : '',
          `<div class="foot mono"><span><span class="dot"></span>${esc(brand.handle)}</span><span>Swipe</span></div>`,
        ].filter(Boolean).join('\n'),
        css: [TOP_CSS, '.title{margin-top:64px}', '.rows{margin-top:48px}', '.body{margin-top:48px;line-height:1.45}',
          '.foot{display:flex;justify-content:space-between;align-items:center;margin-top:auto;padding-top:64px;font-size:var(--fs-label);line-height:1.2;color:var(--muted)}'].join('\n'),
      };
    case 'code':
      return {
        kind: 'design', name: 'code', ground: 'paper', chrome: 'none', notes: notes('code'),
        html: [
          top(slide.file || tipLabel, counter),
          `<pre class="editor${slide.diff ? ' diff' : ''}">${esc(slide.code)}</pre>`,
          slide.caption ? `<p class="t-caption caption">${inline(slide.caption)}</p>` : '',
        ].filter(Boolean).join('\n'),
        css: [TOP_CSS, '.editor{margin-top:48px}', '.caption{margin-top:auto}'].join('\n'),
      };
  }
}

export type DesignSystem = {
  canvas: { width: number; height: number; safeInset: number };
  variables: { name: string; value: string; use: string }[];
  classes: { name: string; example: string; use: string }[];
  typeScale: { name: string; size: string; weight: string; use: string }[];
  spacing: Record<string, string>;
  radii: Record<string, string>;
  fonts: { sans: string; mono: string };
  chrome: string[];
  rules: string[];
};

/** The brand layer as data (for get_design_system and the brand guide). */
export function designSystem(brand: BrandPack): DesignSystem {
  const extra = designVars(brand);
  return {
    canvas: { width: W, height: H, safeInset: SAFE },
    variables: [
      ...VARS.map(([name, role, use]) => ({ name: `--${name}`, value: roleColor(brand, role), use })),
      { name: '--surface', value: extra.surface, use: 'Raised panels and cards on paper' },
      { name: '--sans', value: family(brand, 'sans'), use: 'Brand sans: headings and body' },
      { name: '--mono', value: family(brand, 'mono'), use: 'Brand mono: code and small labels only' },
      ...extra.spacing.map(t => ({ name: `--${t.name}`, value: t.value, use: t.usage ?? 'Spacing step' })),
      ...extra.radii.map(t => ({ name: `--${t.name}`, value: t.value, use: t.usage ?? 'Corner radius' })),
      ...typeScale(brand).map(t => ({ name: `--fs-${t.name}`, value: t.size, use: `Font size of .t-${t.name}` })),
    ],
    classes: CLASSES,
    typeScale: typeScale(brand).map(t => ({
      name: `.t-${t.name}`, size: t.size, weight: t.weight,
      use: `${t.use} (${t.family}, line-height ${t.lineHeight}${t.tracking !== '0' ? `, tracking ${t.tracking}` : ''})`,
    })),
    spacing: Object.fromEntries(extra.spacing.map(t => [t.name, t.value])),
    radii: Object.fromEntries(extra.radii.map(t => [t.name, t.value])),
    fonts: { sans: family(brand, 'sans'), mono: family(brand, 'mono') },
    chrome: CHROME_DOC,
    rules: DESIGN_RULES,
  };
}
