import { getBrand } from '@/lib/brand';
import { SLIDE_FORMAT_GUIDE } from '@/lib/slides';

export const WORKFLOW = `Carousel Studio workflow for agents:
1. Call get_brand_guide once per session and follow it (voice, limits, and "Designing slides": your own concept, palette and layouts for every carousel).
2. list_requests shows what the human asked for: "note" = feedback pinned on a slide (slide = 1-based number, x/y as 0-1 fractions of the image), "new" = make a new carousel from the text.
3. claim_request before working on one (another agent may hold it; leases expire after 30 min).
4. Make the change:
   - notes: edit_slide / insert_slide / remove_slide / move_slide for targeted edits, or update_slides with the full array. Every change saves a NEW version and renders it.
   - "new": design the carousel (see "Designing slides") and save it with create_carousel.
   Pass baseVersion (the version you read) on edits; a "stale" error means another agent saved first: re-read with get_carousel and redo the change.
5. Optionally view_slides to check the rendered result.
6. complete_request with a one-line reply and the resulting version. dismiss_request if it should not be done (reopen_request undoes done/dismissed). add_note pins feedback on a slide; request_carousel queues a new-carousel prompt.

Conventions:
- Slide numbers in every tool input and output are 1-based (slide 1 = the first slide).
- Your API key has scopes: read (look only), write (edit carousels and requests), admin (brand, API keys, permanent delete). A "missing scope" error means ask the human for a key with more access.
- delete_carousel moves a carousel to the trash (restore_carousel undoes it). Only purge_carousel deletes for good, and only from the trash.
- Status (draft → review → approved → posted) belongs to the human; agents normally leave it alone. Edits set it back to review.
- Every write is recorded in the activity log (list_activity) under your key's name.`;

/**
 * The brand README, minus everything that makes every carousel look the same: the "## Template: …" sections
 * (fixed slide layouts) and the visual rules about colour use, signature moves, layout, radii and motion
 * (e.g. "covers are Racing Green"). Kept: voice/content, type, fonts, logo. Each carousel picks its own palette.
 */
const DROP_SUBSECTIONS = /^### (Colou?r|Signature moves|Layout and spacing|Radii, borders, elevation|Motion)\b/;
export function brandReadme(readme: string) {
  return readme
    .split(/\n(?=## )/).filter(sec => !/^## Template:/.test(sec.trim()))
    .map(sec => sec.split(/\n(?=### )/).filter(sub => !DROP_SUBSECTIONS.test(sub.trim())).join('\n'))
    .join('\n').trim();
}

/** Workflow + slide format + active brand README. Same text for the tool, the resource and the prompts. */
export async function brandGuideText() {
  const b = await getBrand();
  let designing = '';
  try { designing = `\n\n${await designingGuideText()}`; } catch { /* design system not available: guide still works */ }
  return `${WORKFLOW}\n\n# Slide format\n${SLIDE_FORMAT_GUIDE}${designing}\n\n# Brand: ${b.name}\nHandle: ${b.handle} (show it once or twice per carousel, where it fits). Series label prefix (optional, rarely needed): "${b.labelPrefix}".\nThe brand gives you its FONTS and its VOICE. It does NOT give you colors or layouts: every carousel gets its own palette and its own design.\nWhere the brand book below describes a look (a color like racing green, paper pages, a highlighted phrase), read it as one past style the brand has used, not a rule. Take its voice, type and font guidance; ignore its color and layout prescriptions.\n\n${brandReadme(b.readme)}`;
}

const THINKING = `## Think like a designer (this is the job, not filling a template)
There are no slide templates. You design every slide of every carousel.

1. Understand the idea first: what is the ONE thing the reader should remember? What is the story arc (hook, tension, insight, proof, takeaway)?
2. Pick a visual concept for THIS carousel before writing any HTML, and write it in the first slide's "notes" (e.g. "a terminal session", "a lab notebook", "a scoreboard", "a field guide", "a map with checkpoints", "a magazine spread", "a receipt", "an x-ray of the code"). The concept drives layout, scale, rhythm and color.
   Then pick a PALETTE for this carousel that fits the concept (3 to 5 colors: background, text, one or two accents, a surface), e.g. amber on near-black for a terminal, signal red on off-white for an editorial, cyan lines on deep blue for a blueprint, warm kraft and ink for a notebook. Do not default to the brand green: it is just one option. Define the palette as CSS variables at the top of EVERY slide's css so it stays consistent, e.g. "&{--bg:#101418;--fg:#f4efe6;--accent:#ffb000;--muted:#8a8f98;background:var(--bg);color:var(--fg)}", and restyle helpers to match (e.g. "mark{background:var(--accent);color:var(--bg)}", ".card{background:...}", ".editor{background:...}"). Write the palette in the first slide's notes too. Keep text readable (WCAG AA contrast is checked).
3. Plan the sequence: one idea per slide, and choose each slide's layout from its content (a number becomes a hero number, a process becomes steps or a timeline, a trade-off becomes a split, code becomes an annotated editor, a mistake becomes a crossed-out row next to the fix).
4. Design, preview_slide, look at the image critically, and iterate: hierarchy, balance (no empty bottom half), alignment, breathing room, contrast. Warnings are the floor, not the goal.
5. Before you save (MANDATORY self-check). preview_slide EVERY slide in its final form and LOOK at the returned image. Answer each question honestly; if any answer is no, fix and preview again:
   a. Phone test: at a glance on a small screen, is there one clear focal point and is every word readable?
   b. Balance: no dead empty half or corner; the content fills the slide on purpose.
   c. Hierarchy: at most 3 text sizes; headline > support > detail is obvious.
   d. Palette: same carousel palette as the other slides; nothing looks like the default brand green unless the concept chose it.
   e. Variety: this slide's layout differs from the previous one; the cover is not a "label + big hook" formula.
   f. Defaults: no footer, highlight, kicker label or keycap that the design doesn't need.
   g. Copy: one idea, about 25 words or fewer, no em dashes or emoji, technically correct (code runs as shown).
   Then record it in the slide's notes, e.g. "self-check: ok (fixed empty bottom, larger code)".
   Saves report "selfCheck" with any slide saved without a preview of that exact design: preview it, look, fix.

Variety rules:
- Do not reuse the same structure for every carousel. A cover is not always "small label top, big hook bottom": try a giant word, a question, a split, a code fragment, a number, a diagram, a full-bleed color field.
- Adjacent slides should not share the same layout. Vary scale (huge vs small type), density, background treatment and alignment (left, centered, asymmetric).
- Different carousels must not look alike: different palette, different concept, different cover idea. Never reuse the previous carousel's colors.
- No default decorations. Do NOT add these by habit: a footer on every slide, a highlighted (<mark>) phrase on every slide, small monospace kicker labels ("USE 01", "THE CSS ISSUE"), keycap tags, a "Tip 014" label. Use one only when this specific design needs it (a highlighter on 1 or 2 slides of the carousel at most).
- The handle: put it where it fits the design, at least on the first or last slide (e.g. a small signature on the cover, or part of the closing slide). chrome defaults to "none"; the studio footer (chrome "auto" / "handle") is opt-in.
- There is no rule about cover or closing colors: a cover can be any color, any style.

Layout ideas (combine and invent; never copy blindly): hero number with a tiny caption; question and answer split across the slide; two-column before/after or myth/fact; vertical timeline or numbered steps; checklist with checked and crossed rows; annotated code with callout labels; a small diagram in inline SVG (boxes, arrows, flow); a "receipt" or "terminal" mock; a quote card; a scale or meter; a grid of 4 small cards; a single giant word; a mistake row struck through next to the correct row; a map of where something happens (client, server, edge).

Syntax only (structure, not a design to copy):
{"kind":"design","name":"<what this slide is>","ground":"paper","html":"<div class=\\"x\\">…your markup…</div>","css":".x{…your layout using var(--primary), var(--space-6), var(--fs-title)…}","notes":"<the concept and the idea of this slide>"}`;

/** "Designing slides" guide section. Variables and classes come from designSystem() so it stays in sync with the brand. */
export async function designingGuideText() {
  const { designSystem } = await import('@/lib/render/design');
  const b = await getBrand();
  const d = designSystem(b);
  const vars = d.variables.map(v => `- var(${v.name}) = ${v.value}: ${v.use}`).join('\n');
  const classes = d.classes.map(c => `- .${c.name.replace(/^\./, '')}: ${c.use}. Example: ${c.example}`).join('\n');
  const type = d.typeScale.map(t => `- ${t.name}: ${t.size} / ${t.weight}, ${t.use}`).join('\n');
  const kv = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ');
  return `# Designing slides
Every slide is designed by you: { kind: "design", html, css?, chrome?, ground?, name?, notes? }. The brand supplies its fonts and voice (and spacing/type scale helpers); you supply the concept, the palette and the layout.

${THINKING}

## Workflow
1. get_design_system (same data as below, as JSON). list_layouts / get_layout show layouts saved earlier (reuse them only when they fit the concept). get_slide_source turns a slide of an older carousel into editable design source.
2. Write html (slide body only, no html/head/script) and css (this slide only).
3. preview_slide: returns the PNG plus { errors, warnings }. Nothing is saved.
4. Fix every warning you can, preview again.
5. Save with create_carousel / update_slides / edit_slide / insert_slide. Saving is refused only on errors (off-canvas overflow, sanitizer rejections); warnings come back per slide.
6. Repeated pattern? save_layout with {{placeholders}}, then use { kind: "design", layout: "<name>", fill: { ... } }.
Images: upload_asset (PNG/JPEG/WebP/SVG, 2 MB) and use the returned url in <img src>. Inline <svg> and data: URIs work too. Nothing else loads: JavaScript is off and the network is blocked, so no external fonts, images or CSS.

## Canvas
${d.canvas.width}x${d.canvas.height}px. Keep content inside the ${d.canvas.safeInset}px safe area. Flow content inside the slide root (see rules); use flex or grid.
Fonts (the one fixed brand element): sans = ${d.fonts.sans}; mono = ${d.fonts.mono} (code and technical text).
Spacing: ${kv(d.spacing)}. Radii: ${kv(d.radii)}.
Chrome (set "chrome"): ${d.chrome.join('; ')}.

## CSS variables (helpers, NOT a required palette)
The brand's own colors are available as variables if a carousel's concept suits them, but each carousel should define its own palette (see above) and is free to ignore these.
${vars}

## Brand classes
${classes}

## Type scale
${type}

## Rules (the checks behind errors and warnings)
${d.rules.map(r => `- ${r}`).join('\n')}
- Text of 24px or more only. Brand fonts only. Any colors (your carousel palette); keep text contrast at WCAG AA. At most one <mark> per slide, and only when it helps.
- In html, write marker as <mark>phrase</mark>; in layout fill values use *phrase* and \`code\`.
- Do not use em dashes or emoji (brand voice).`;
}
