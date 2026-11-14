import { z } from 'zod';

// Legacy template text fields support two inline marks:  *phrase*  → the marker,  `code` → inline code.
const text = (d: string) => z.string().min(1).describe(d);

export const CoverSlide = z.object({
  kind: z.literal('cover'),
  label: z.string().optional().describe('Keycap label, e.g. "Tip 014". Defaults to the carousel tip number.'),
  hook: text('The hook, max ~12 words, max 4 lines. Mark exactly one phrase with *asterisks*.'),
  sub: z.string().optional().describe('Optional one-line sub under the hook.'),
});

export const ContentSlide = z.object({
  kind: z.literal('content'),
  title: text('Slide title, max ~8 words. May mark one phrase with *asterisks*.'),
  points: z.array(z.string()).max(4).optional().describe('2 to 4 short points (preferred), each under ~8 words.'),
  body: z.string().optional().describe('Short paragraph instead of points, about 25 words.'),
});

export const CodeSlide = z.object({
  kind: z.literal('code'),
  file: z.string().optional().describe('Filename shown above the editor, e.g. "date-input.html".'),
  code: text('The code. Max 32 characters per line, max ~10 lines. For a before/after diff prefix lines with "- " or "+ " and set diff: true.'),
  diff: z.boolean().optional().describe('true when lines are prefixed with "- " (removed) and "+ " (added).'),
  caption: z.string().optional().describe('Caption under the editor with one *marked* phrase.'),
});

export const CtaSlide = z.object({
  kind: z.literal('cta'),
  hook: text('Closing line, e.g. "Save this for your *next form*."'),
  sub: z.string().optional().describe('Optional follow line, e.g. "One dev tip, four days a week."'),
});

// ---------- Phase 3: agent-designed slides ----------
// The agent designs the layout (HTML/CSS); the studio supplies the brand layer, sanitizes, scopes the css and draws the chrome.

/** Brand chrome the studio draws on a design slide: auto = handle footer + "n / total". */
export const Chrome = z.enum(['auto', 'none', 'handle', 'counter']);
export type Chrome = z.infer<typeof Chrome>;

/** Ground (background + text + chrome colors) of a design slide. */
export const Ground = z.enum(['paper', 'primary', 'dark']);
export type Ground = z.infer<typeof Ground>;

export const DesignSlide = z.object({
  kind: z.literal('design'),
  html: z.string().min(1).max(60_000).describe('Slide body HTML (no <html>/<head>/<script>). 1080x1350 canvas, brand CSS variables and classes available. See get_brand_guide "Designing slides".'),
  css: z.string().max(30_000).optional().describe('CSS for this slide only (scoped by the studio).'),
  chrome: Chrome.optional().describe('Studio footer: none (default; place the handle yourself), auto (handle + counter), handle, counter. Opt-in, not on every slide by habit.'),
  ground: Ground.optional().describe('Optional base ground helper: paper (default, light), primary (brand green) or dark. Most designs set their own palette in css instead.'),
  name: z.string().max(80).optional().describe('Short label for humans, e.g. "big number", "comparison".'),
  notes: z.string().max(2000).optional().describe('Design intent; not rendered.'),
});
export type DesignSlide = z.infer<typeof DesignSlide>;

/** Input-only: a design slide made from a saved layout. Resolved to a DesignSlide before saving. */
export const LayoutRef = z.object({
  kind: z.literal('design'),
  layout: z.string().min(1).describe('Name of a saved layout (list_layouts).'),
  fill: z.record(z.string(), z.string()).optional().describe('Placeholder values; text supports *marker* and `code`.'),
  chrome: Chrome.optional(),
  ground: Ground.optional(),
});
export type LayoutRef = z.infer<typeof LayoutRef>;

// ---------- all slides ----------

export const Slide = z.discriminatedUnion('kind', [CoverSlide, ContentSlide, CodeSlide, CtaSlide, DesignSlide]);
export type Slide = z.infer<typeof Slide>;
export const Slides = z.array(Slide).min(2).max(10).describe('5 to 8 slides: a cover first, a cta last, content/code/design in between.');

/** Legacy kinds: still stored in (and rendered for) older carousels, never accepted for new slides. */
export const TEMPLATE_KINDS = ['cover', 'content', 'code', 'cta'] as const;
const TEMPLATES_REMOVED = 'Template slides (cover, content, code, cta) were removed. Design every slide yourself: { kind: "design", html, css? } (see get_brand_guide "Designing slides" and get_design_system), or { kind: "design", layout, fill } from a saved layout.';

/**
 * Tool input: a design slide, or a design slide made from a saved layout ({ kind: "design", layout, fill }).
 * Resolve with resolveSlideInputs (src/lib/layouts.ts). Template kinds are rejected with an explanation.
 */
export const SlideInput = z.union([DesignSlide, LayoutRef], {
  error: iss => {
    const kind = (iss.input as { kind?: unknown } | null | undefined)?.kind;
    return typeof kind === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(kind) ? TEMPLATES_REMOVED : undefined;
  },
});
export type SlideInput = z.infer<typeof SlideInput>;
export const SlideInputs = z.array(SlideInput).min(2).max(10).describe('5 to 8 slides, each one designed by you ({ kind: "design", html, css? }). No templates.');

export const SLIDE_FORMAT_GUIDE = `Every slide is { kind: "design", html, css?, chrome?, ground?, name?, notes? }: a slide you design yourself in HTML/CSS on the brand layer
(or { kind: "design", layout, fill } from a layout saved earlier). There are no templates. See "Designing slides" / get_design_system; check each slide with preview_slide.
Older carousels may still contain legacy template slides (cover, content, code, cta): they keep rendering, but new or replaced slides must be design slides (get_slide_source converts one).
In html, <mark>phrase</mark> is an optional highlighter (at most one per slide, restyle it to your palette), <code>x</code> is inline code. In layout fill values use *phrase* and \`code\`.
Limits: 5-8 slides, ~25 words per slide, code lines <= 32 chars. No em dashes, no emoji.`;

/** Blank canvas for a new carousel started in the studio: two design slides to replace with a real design. */
export const starterSlides = (): Slide[] => [
  {
    kind: 'design', name: 'start here', ground: 'dark', chrome: 'none',
    html: '<h1 class="t-hook">Your <mark>idea</mark> here</h1>',
    css: '&{justify-content:center}',
    notes: 'Blank canvas. Ask an agent to design this carousel, or edit the HTML/CSS yourself.',
  },
  {
    kind: 'design', name: 'blank', ground: 'paper', chrome: 'none',
    html: '<p class="t-title">Design this slide</p>',
    css: '&{justify-content:center;align-items:center;text-align:center}',
  },
];
