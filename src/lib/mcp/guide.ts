import { getBrand } from '@/lib/brand';
import { SLIDE_FORMAT_GUIDE } from '@/lib/slides';

export const WORKFLOW = `Carousel Studio workflow for agents:
1. Call get_brand_guide once per session and follow it (voice, one marked phrase per slide, limits).
2. list_requests shows what the human asked for: "note" = feedback pinned on a slide (slide = 1-based number, x/y as 0-1 fractions of the image), "new" = make a new carousel from the text.
3. claim_request before working on one (another agent may hold it; leases expire after 30 min).
4. Make the change:
   - notes: edit_slide / insert_slide / remove_slide / move_slide for targeted edits, or update_slides with the full array. Every change saves a NEW version and renders it.
   - "new": create_carousel.
   Pass baseVersion (the version you read) on edits; a "stale" error means another agent saved first: re-read with get_carousel and redo the change.
5. Optionally view_slides to check the rendered result.
6. complete_request with a one-line reply and the resulting version. dismiss_request if it should not be done (reopen_request undoes done/dismissed). add_note pins feedback on a slide; request_carousel queues a new-carousel prompt.

Conventions:
- Slide numbers in every tool input and output are 1-based (slide 1 = cover).
- Your API key has scopes: read (look only), write (edit carousels and requests), admin (brand, API keys, permanent delete). A "missing scope" error means ask the human for a key with more access.
- delete_carousel moves a carousel to the trash (restore_carousel undoes it). Only purge_carousel deletes for good, and only from the trash.
- Status (draft → review → approved → posted) belongs to the human; agents normally leave it alone. Edits set it back to review.
- Every write is recorded in the activity log (list_activity) under your key's name.`;

/** Workflow + slide format + active brand README. Same text for the tool, the resource and the prompts. */
export async function brandGuideText() {
  const b = await getBrand();
  let designing = '';
  try { designing = `\n\n${await designingGuideText()}`; } catch { /* design system not available: guide still works */ }
  return `${WORKFLOW}\n\n# Slide format\n${SLIDE_FORMAT_GUIDE}${designing}\n\n# Brand: ${b.name}\nHandle on slides: ${b.handle}. Label: "${b.labelPrefix} 014".\n\n${b.readme}`;
}

const EXAMPLES = `## Example design slides (complete; pass as the slide object)

Big number:
{"kind":"design","name":"big number","html":"<span class=\"key\">Tip 014</span><div class=\"num\">73%</div><h2 class=\"t-title\">of the bundle was <mark>one</mark> import</h2><p class=\"t-body muted\">Check yours with a bundle analyzer.</p>","css":".num{font-size:320px;line-height:1;font-weight:700;color:var(--primary);letter-spacing:-8px;margin:48px 0 24px}"}

Side-by-side comparison:
{"kind":"design","name":"comparison","html":"<h2 class=\"t-title\">Before vs <mark>after</mark></h2><div class=\"cols\"><div class=\"card\"><span class=\"chip\">Before</span><p class=\"t-body\">Fetch in useEffect, manual loading state</p></div><div class=\"card primary\"><span class=\"chip\">After</span><p class=\"t-body\">Server component, no client JS</p></div></div>","css":".cols{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:64px;flex:1}.cols .card{display:flex;flex-direction:column;gap:32px;padding:40px}"}

Annotated code:
{"kind":"design","name":"annotated code","html":"<h2 class=\"t-title\">Why this is <mark>safe</mark></h2><pre class=\"editor\">// 1. validate first
const data = schema.parse(input)
// 2. then use it
save(data)</pre><p class=\"t-caption\">Parse, do not trust.</p>","css":"&{gap:48px}"}`;

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
Besides the four templates (cover, content, code, cta) you can design any slide yourself as { kind: "design", html, css?, chrome?, name?, notes? }. The brand supplies the system; you supply the layout. Use a design slide when a template cannot show the idea: big numbers, comparisons, diagrams, checklists, timelines, annotated code.

## Workflow
1. get_design_system (same data as below, as JSON). get_slide_source turns any template slide into an editable design slide; list_layouts / get_layout show reusable layouts.
2. Write html (slide body only, no html/head/script) and css (this slide only).
3. preview_slide: returns the PNG plus { errors, warnings }. Nothing is saved.
4. Fix every warning you can, preview again.
5. Save with create_carousel / update_slides / edit_slide / insert_slide. Saving is refused only on errors (off-canvas overflow, sanitizer rejections); warnings come back per slide.
6. Repeated pattern? save_layout with {{placeholders}}, then use { kind: "design", layout: "<name>", fill: { ... } }.
Images: upload_asset (PNG/JPEG/WebP/SVG, 2 MB) and use the returned url in <img src>. Inline <svg> and data: URIs work too. Nothing else loads: JavaScript is off and the network is blocked, so no external fonts, images or CSS.

## Canvas
${d.canvas.width}x${d.canvas.height}px. Keep content inside the ${d.canvas.safeInset}px safe area (the studio draws the handle and "n / total" chrome there). Flow content inside the slide root (see rules); use flex or grid.
Fonts: sans = ${d.fonts.sans}; mono = ${d.fonts.mono} (code and labels only).
Spacing: ${kv(d.spacing)}. Radii: ${kv(d.radii)}.
Chrome (set "chrome"): ${d.chrome.join(', ')}. Default auto = handle footer + counter. Use none for full-bleed designs.

## CSS variables (use these, not hex values)
${vars}

## Brand classes
${classes}

## Type scale
${type}

## Rules (the checks behind errors and warnings)
${d.rules.map(r => `- ${r}`).join('\n')}
- ONE <mark> / *marker* phrase per slide. Text of 24px or more only. Brand fonts and palette colors only. Keep text contrast at WCAG AA.
- In html, write marker as <mark>phrase</mark>; in layout fill values and template text use *phrase* and \`code\`.
- Do not use em dashes or emoji (same voice rules as templates).

${EXAMPLES}`;
}
