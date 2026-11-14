import { z } from 'zod';

// Text fields support two inline marks:  *phrase*  → the brand marker (use ONE per slide),  `code` → inline code.
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

export const Slide = z.discriminatedUnion('kind', [CoverSlide, ContentSlide, CodeSlide, CtaSlide]);
export type Slide = z.infer<typeof Slide>;
export const Slides = z.array(Slide).min(2).max(10).describe('5 to 8 slides: a cover first, a cta last, content/code in between.');

export const SLIDE_FORMAT_GUIDE = `Slides are JSON objects with a "kind":
- cover   { kind, label?, hook, sub? }        racing-green cover. First slide.
- content { kind, title, points?[] | body? }  paper slide with a title and 2-4 points.
- code    { kind, file?, code, diff?, caption? }  dark editor card. Diff lines start with "- " or "+ ".
- cta     { kind, hook, sub? }                racing-green closing slide. Last slide.
Inline marks in text: *phrase* = the brand highlighter (ONE per slide), \`code\` = inline code.
Limits: 5-8 slides, ~25 words per slide, code lines <= 32 chars. No em dashes, no emoji.`;

export const starterSlides = (): Slide[] => [
  { kind: 'cover', hook: 'Stop doing *this* in your code.', sub: 'There is a simpler way.' },
  { kind: 'content', title: 'Why it *matters*', points: ['First reason', 'Second reason', 'Third reason'] },
  { kind: 'code', file: 'example.ts', code: '- oldWay()\n+ newWay()', diff: true, caption: 'Less code, *same result*.' },
  { kind: 'cta', hook: 'Save this for your *next project*.', sub: 'One dev tip, four days a week.' },
];
