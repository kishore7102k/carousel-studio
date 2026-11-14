# Phase 3: Agent-designed slides (the brand is a system, not a template)

**Prerequisite:** Phases 1 and 2 are done (MCP tools with scopes, OAuth). Phase 2 item 13 (manual connector checks) can finish in parallel.

**Problem.** Today every slide is one of four hard-coded layouts (`cover`, `content`, `code`, `cta` in `src/lib/render/html.ts`). An agent can only fill in text, so every carousel looks the same. The brand pack only recolors and refonts those four layouts.

**Goal.** Agents design each slide themselves: layout, hierarchy, diagrams, comparisons, big numbers, checklists, timelines, annotated code, whatever explains the idea best, and upload it over MCP. The brand supplies the **system** (colors, fonts, spacing, radii, signature moves like the marker and keycap, the handle footer), not the layout. The studio renders, checks and versions it exactly like today. The four templates stay as presets.

The loop an agent runs: read the brand system → design a slide → **preview** it (PNG + automatic checks) → fix → save as a version → the human reviews and pins notes → the agent revises.

Read `AGENTS.md` (Next.js 16) and this whole file first.

---

## 1. Design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| What an agent sends | A new slide kind `design`: `{ kind: 'design', html, css?, chrome?, name?, notes? }`. `html` is the slide body (no `<html>`/`<head>`), `css` is scoped to the slide. | Every agent (Claude, ChatGPT, Gemini, Codex) can already write HTML/CSS well. A custom layout DSL would be weaker and need teaching. |
| How the brand is applied | A shared **brand layer** injected into every slide: `@font-face` for the brand fonts, CSS variables for every role (`--primary`, `--paper`, `--ink`, `--marker`, `--code-bg`…), spacing/radius/type-scale variables from `tokens.json`, and brand utility classes (`mark`, `.key`, `.dot`, `.editor` code block with highlighting, `.chip`, `.card`). | Agents design freely but can only reach brand colors/fonts conveniently; the checks below catch drift. |
| Brand chrome | `chrome: 'auto' | 'none' | 'handle' | 'counter'` (default `auto` = handle footer + `n / total` like the templates). Rendered by the studio, not the agent. | The handle and counter stay consistent and correct when slides move. |
| Safety | Render with **JavaScript disabled**, **all network blocked** except `data:` URIs and the studio's own Blob store host, a strict CSP meta tag, size limits (html ≤ 60 KB, css ≤ 30 KB). Strip `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`, `on*` attributes and `javascript:` URLs before storing. | Agent HTML runs in our server's Chromium: no JS, no outbound requests = no SSRF and no exfiltration. No new dependency needed. |
| Quality checks (lint) | After rendering, measure in the page: content overflowing the 1080×1350 canvas or the safe area (64 px inset), text below 24 px, fonts that are not brand fonts, colors not in the brand palette (computed styles), more than one `mark` (brand rule), contrast below WCAG AA for text. Returned as `warnings` (and `errors` for overflow off-canvas). | The agent gets objective feedback to iterate on, like a designer's review. |
| Assets | `upload_asset` (PNG/JPEG/WebP/SVG ≤ 2 MB → Blob, SVG sanitized) returns a URL usable in `html`. Inline SVG is allowed in `html`. | Diagrams, icons, screenshots, logos without opening network access. |
| Reuse | `save_layout` stores a design slide as a named **layout** with `{{placeholders}}`; `list_layouts`, and `create_carousel`/`insert_slide` accept `{ kind: 'design', layout: '<name>', fill: {...} }`. | Agents (and you) build a growing library of on-brand layouts instead of four fixed ones. |
| Templates | The four kinds keep rendering **pixel-identical** (verified). `get_slide_source` converts any template slide into an editable `design` slide (same look), so agents can remix presets. | No regressions; presets become starting points. |

## 2. Data model

- `Slide` union gains `DesignSlide` (`src/lib/slides.ts`). Versions keep storing slides as JSON: no migration for slides.
- New table `layouts { id uuid pk, name text unique, description text, html text, css text, placeholders text[], thumbnail text null, created_by text, created_at, updated_at }`.
- New table `assets { id uuid pk, url text, kind text, bytes int, width int null, height int null, created_by text, created_at }` (so assets are listable and purgeable).

## 3. Rendering (`src/lib/render/*`)

1. Split `html.ts` into `brand-layer.ts` (fonts + variables + utilities + chrome) and the template layouts. **Template output must stay byte-identical**: snapshot test before/after.
2. `designHtml(slide, i, total, brand)` = brand layer + sanitized `html` inside `<section class="slide design">` + scoped `css` + chrome.
3. Renderer: `javaScriptEnabled: false`, `page.route('**', …)` aborting everything except `data:` and the Blob host, CSP meta. Same 1080×1350 PNG output, same Blob paths.
4. `lintSlide(page)` measures the rendered page with `page.evaluate` (Playwright's evaluation still works when the page's own JavaScript is disabled). Returns `{ errors, warnings }` per slide.

## 4. MCP tools (all through `defineTool`)

| Tool | Scope | Notes |
| --- | --- | --- |
| `get_brand_guide` | read | (exists) add a **"Designing slides"** section: canvas, safe area, every CSS variable and utility class with a one-line example, chrome options, type scale, the lint rules, and 3 short example design slides (big-number, comparison, annotated code). |
| `get_design_system` | read, readOnly | The brand layer as data: variables with values, classes with example HTML, type scale, spacing, radii. For agents that want structure rather than prose. |
| `preview_slide` | read, readOnly | `{ slide, carouselId?, n?, total? }` → PNG image + URL text + `{ errors, warnings }`. Nothing saved (render to memory; image returned inline and as a short-lived Blob URL under `previews/`, deleted after 1 h). The main iteration loop. |
| `create_carousel`, `update_slides`, `edit_slide`, `insert_slide` | write | (exist) accept `design` slides; responses include `warnings` per slide. Saving is refused only on `errors` (off-canvas overflow, sanitizer rejections). |
| `get_slide_source` | read, readOnly | `{ id, slide, version? }` → the slide as a `design` slide (templates converted), so an agent can remix it. |
| `upload_asset` | write | `{ name, mimeType, base64 }` → `{ id, url, width, height }`. Magic-byte check, size limit, SVG sanitized. |
| `list_assets` / `delete_asset` | read / write | |
| `save_layout` / `list_layouts` / `get_layout` / `delete_layout` | write / read / read / write | Layouts with `{{placeholder}}` slots; `fill` values are escaped text (with `*marker*` and `` `code` `` inline marks). |

Every write is activity-logged (existing `defineTool`).

## 5. UI

- Slide viewer: design slides show like any slide (PNG); notes work the same.
- Edit mode for a design slide: HTML and CSS textareas + "Preview" (calls the same preview path) + warnings list. Templates keep their form editor; a "Convert to design" button uses `get_slide_source`.
- New **Layouts** page (sidebar): thumbnails, name, description, delete.
- Warnings badge on slides that have lint warnings.

## 6. Tests and checks (required)

1. `scripts/render-check.ts` gains a **template snapshot** check: render the four kinds with the default brand and compare PNG hashes against the pre-Phase-3 output (commit the hashes, not the PNGs).
2. `scripts/design-smoke.ts` (`npm run design:smoke`) over MCP against the dev server: preview a valid design slide (no errors), an overflowing one (error), one with an off-brand color and a non-brand font (warnings), one with `<script>`, `onerror=`, `<iframe>`, `<link href=http…>`, CSS `url(http://…)` and `@import` (all stripped or blocked; a local request-catcher on 127.0.0.1 must receive **zero** requests); create a mixed carousel (templates + design), `get_slide_source` round-trip, `upload_asset` (valid PNG, fake PNG rejected, SVG with script sanitized), layouts save → use with fill → delete. Cleans up everything.
3. `npm run mcp:smoke` and `npm run oauth:smoke` still pass; `npm run build` + `npm run lint` clean; no new npm dependencies.

## 7. Out of scope

Animated slides / reels (Remotion, later), other canvas sizes (1:1, 9:16), AI image generation inside the studio, a visual drag-and-drop editor, multi-brand.

## 8. Progress log (keep this updated)

After finishing each item, tick it here and commit code + this file together. If you stop mid-item, add a one-line note under it.

- [x] 1. Template snapshot hashes captured (before any render change) in `scripts/render-check.ts`
- [x] 2. `brand-layer.ts` split out of `html.ts`; templates byte/pixel-identical
- [x] 3. `DesignSlide` schema + sanitizer + `designHtml` + chrome
- [x] 4. Locked-down renderer (JS off, network allow-list, CSP) + `lintSlide`
- [ ] 5. `preview_slide`, design slides accepted by create/update/edit/insert with warnings
- [x] 6. `get_design_system`, "Designing slides" section in the brand guide, `get_slide_source`
- [x] 7. Assets: table, `upload_asset` / `list_assets` / `delete_asset` (assets are global, not per carousel, so purge does not remove them)
- [x] 8. Layouts: table + tools + `{ layout, fill }` in slide inputs (resolveSlideInputs ready; Agent A wires it into create/update/insert)
- [x] 9. UI: design slide editor + preview + warnings, Convert to design, Layouts page
- [ ] 10. `scripts/design-smoke.ts` + `npm run design:smoke` passing; other smoke tests still passing
- [ ] 11. README + brand guide docs; build + lint clean
- [ ] 12. Manual: ask Claude.ai and ChatGPT (via the connector) to design a 6-slide carousel on a topic with no template slides; record results here

## 9. Definition of done

An agent connected over MCP (Claude Code, Claude.ai or ChatGPT) can design a carousel whose slides are not any of the four templates, iterate with previews and warnings, and save it; it renders on-brand (fonts, colors, marker, chrome) on the deployed app. Templates are unchanged. All smoke tests, build and lint pass. Do not push or deploy without the maintainer's go-ahead.
