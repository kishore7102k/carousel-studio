# Carousel Studio

An open-source studio for social media carousels that humans review and **any MCP-capable agent** edits.

You pin notes on slides ("code too small here"), and agents like Claude Code, Codex, Cursor or your own scripts pick them up through the MCP server, change the slides, render new PNGs and reply. Every change is a new version, so nothing is lost.

- **Review UI**: gallery, slide viewer with pinned notes, text editing, versions, approve → posted.
- **MCP server** at `/api/mcp`: create, edit, render and view carousels, and work a shared request queue with claim/lease so multiple agents never collide.
- **Server-side rendering**: slides are HTML templates rendered to 1080×1350 PNGs by headless Chromium (Playwright locally, `@sparticuz/chromium` on Vercel), stored in Vercel Blob.
- **Brand packs**: colors, fonts and voice live in the database and can be imported from a design-system `tokens.json`. Licensed fonts never enter the repo.

## How it works

```
 You (browser) ──▶ Studio UI ──┐                ┌── Neon Postgres: carousels, versions, requests, brand, API keys
                               ├──▶ Next.js ────┤
 Agents (MCP) ──▶ /api/mcp ────┘    renderer ───┴── Vercel Blob: rendered PNGs
```

1. Ask for a carousel (prompt) or start from the template.
2. An agent claims the request, writes slides with `create_carousel`, which renders them.
3. You click on a slide to pin a note. It lands in the queue.
4. An agent claims it, edits the slide (`edit_slide` or `update_slides`: new version + render) and calls `complete_request` with a reply.
5. You approve and post.

## Deploy on Vercel

1. Fork this repo and import it in Vercel.
2. Add storage from the Vercel Marketplace: **Neon** (Postgres) and **Blob** (public store). Both set their env vars automatically.
3. Add env vars:

   | Variable | Value |
   | --- | --- |
   | `STUDIO_PASSWORD` | Password for the web UI |
   | `STUDIO_SESSION_SECRET` | 32+ random bytes, e.g. `openssl rand -hex 32` |
   | `STUDIO_URL` | Optional. Public URL used in links returned to agents (default: the Vercel production domain) |

4. Create the tables once: `vercel env pull .env.local && npm run db:push`.
5. Deploy, sign in, open **Agents** and create a key per agent.

## Local development

```bash
npm install
vercel link && vercel env pull .env.local   # or copy .env.example and fill it
npm run db:push
npm run dev
```

Rendering locally uses an installed Chrome or Edge (`CHROME_PATH` to override). Smoke test: `npx tsx scripts/render-check.ts out/`.

## Connect an agent

There are two ways in, both at the same URL `https://<your-app>/api/mcp`:

| Client | How it signs in |
| --- | --- |
| Claude Code, Codex, Cursor, Antigravity, scripts | **API key** in an `Authorization: Bearer ks_…` header (below) |
| ChatGPT (developer mode), Claude.ai (custom connector, web/desktop/mobile), Gemini app | **OAuth**: paste the URL only, sign in with the studio password, choose scopes, Allow |
| MCP Inspector | Either |

### Web apps (OAuth)

- **ChatGPT**: Settings → Apps & Connectors → Advanced → Developer mode on → Create / "Add custom MCP server" → URL `https://<your-app>/api/mcp`, Authentication **OAuth** → sign in → Allow.
- **Claude.ai**: Settings → Connectors → Add custom connector → URL → Connect → sign in → Allow.
- **Gemini app**: Settings → Connected apps → Add custom app (MCP) → URL → sign in → Allow (availability depends on Google's region and plan).

Connected apps show up on the **Agents** page next to the API keys, with their scopes and last use. **Disconnect** revokes all their tokens; the activity log names them by client name (e.g. `ChatGPT`).

How it works: the studio is its own OAuth 2.1 authorization server (authorization code + PKCE S256 only) and `/api/mcp` is the protected resource. It serves RFC 9728 / RFC 8414 discovery documents under `/.well-known/`, dynamic client registration (`/oauth/register`) and Client ID Metadata Documents (an `https://` URL as `client_id`, fetched with an SSRF guard), token rotation with reuse detection, revocation (`/oauth/revoke`), `iss` on every authorization response (RFC 9207) and audience-bound tokens (RFC 8707). Access tokens last 1 hour, refresh tokens 60 days. Tokens, codes and client secrets are stored as SHA-256 hashes only. The single "user" who consents is whoever knows `STUDIO_PASSWORD`. Set `STUDIO_URL` to your public URL if it isn't the Vercel production domain, because the OAuth issuer and token audience are derived from it.

### API keys

Create a key on the **Agents** page, then:

```bash
# Claude Code
claude mcp add --transport http carousel-studio https://<your-app>/api/mcp --header "Authorization: Bearer <key>"
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.carousel-studio]
url = "https://<your-app>/api/mcp"
http_headers = { Authorization = "Bearer <key>" }
```

```json
// Cursor (.cursor/mcp.json)
{ "mcpServers": { "carousel-studio": { "url": "https://<your-app>/api/mcp", "headers": { "Authorization": "Bearer <key>" } } } }
```

Then ask the agent: *"Check the carousel studio requests and handle them."*

### Scopes

Every key has a scope, chosen when you create it on the **Agents** page (or with the `create_key` tool):

| Scope | Can |
| --- | --- |
| `read` | Look at carousels, versions, images, requests, the brand and the activity log. |
| `write` | Everything in `read`, plus create and edit carousels and slides, render, trash/restore, and work the request queue. |
| `admin` | Everything in `write`, plus brand changes, API key management and permanent delete. |

A tool called without the needed scope returns the error `missing scope: write` (or `admin`).

### Tools

Slide numbers in every tool input and output are **1-based**. Every slide change saves a **new version** from the current one and renders it (`render: false` skips rendering). Slide-editing tools take an optional `baseVersion`: if another agent saved first, the call fails with `stale: current version is N` instead of overwriting their work.

| Tool | Scope | What it does |
| --- | --- | --- |
| `get_brand_guide` | read | Workflow, slide format and the active brand's rules. Agents read this first. |
| `list_carousels` | read | Browse carousels; filter by `query`, `status`, `includeTrashed`, `limit`. |
| `get_carousel` | read | Slides, images, version history and requests of one carousel. |
| `create_carousel` | write | New carousel as version 1, rendered. |
| `update_carousel` | write | Change title, tip number or status. (`set_carousel_status` is a deprecated alias.) |
| `duplicate_carousel` | write | Copy a version into a new carousel. |
| `delete_carousel` / `restore_carousel` | write | Move to trash / take out of trash. |
| `purge_carousel` | admin | Delete forever (only from the trash), including its images. |
| `set_current_version` | write | Point the carousel at an older or newer version. |
| `compare_versions` | read | Slide-by-slide diff of two versions. |
| `update_slides` | write | Replace all slides. |
| `edit_slide`, `insert_slide`, `remove_slide`, `move_slide` | write | Targeted slide edits. |
| `render_carousel` | write | Re-render a version. |
| `view_slides` | read | The PNGs as images (plus their URLs as text). |
| `get_download_links` | read | Image URLs in order with file names `01.png`… |
| `list_requests`, `get_request` | read | The human's queue: notes pinned on slides and new-carousel prompts. |
| `add_note`, `request_carousel` | write | Leave a note on a slide, or ask for a new carousel. |
| `claim_request`, `complete_request` | write | Work a request with a 30-minute lease, then reply. |
| `dismiss_request`, `reopen_request` | write | Close a request without doing it, or reopen one. |
| `get_brand` | read | Brand name, handle, roles with colors, font families (never font data). |
| `update_brand`, `import_brand`, `reset_brand` | admin | Edit, import (tokens + woff/woff2 fonts, max 2 MB) or reset the brand. |
| `list_activity` | read | Who did what, newest first. |
| `list_connections`, `create_key`, `revoke_access` | admin | Manage API keys (a key can't revoke itself). |
| `search`, `fetch` | read | OpenAI-compatible search over carousels and requests (ids `carousel:<uuid>`, `request:<uuid>`). |
| `get_design_system` | read | The brand layer as data: CSS variables, classes with examples, type scale, spacing, radii, lint rules. |
| `preview_slide` | read | Render one slide without saving: the PNG plus `errors` / `warnings` from the design checks. |
| `get_slide_source` | read | Any slide as an editable `design` slide (templates converted), to remix. |
| `upload_asset`, `list_assets`, `delete_asset` | write / read / write | Images and SVGs (PNG, JPEG, WebP, SVG; max 2 MB; SVG sanitized) to use in design slides. |
| `save_layout`, `list_layouts`, `get_layout`, `delete_layout` | write / read / read / write | Reusable design layouts with `{{placeholders}}`. |

Also exposed: the resource `studio://brand-guide` and the prompts `make_carousel` (topic → new carousel) and `handle_requests` (claim → fix → complete loop).

### Trash and activity log

Deleting a carousel (UI or `delete_carousel`) moves it to the **Trash** (gallery → Trash), where it can be restored or deleted forever. Every change by a human (`you`) or an agent (its key name) is written to an activity log, shown on each carousel page and readable with `list_activity`.

### Smoke test

With the dev server running (`npm run dev`), `npm run mcp:smoke` creates temporary keys, calls every tool against `STUDIO_URL` (default `http://localhost:3000`), checks scopes, stale versions, claim races, trash/purge and brand output, then deletes everything it created. It briefly changes the brand and restores it afterwards, so don't render carousels while it runs.

`npm run oauth:smoke` tests the OAuth side against the dev server: discovery documents, registration, the real login and consent pages (driven in a local Chrome/Edge via Playwright), the PKCE token exchange, an MCP call with the token, and the failure cases (wrong verifier, reused code, wrong redirect URI or resource, `plain` PKCE, expired token, refresh-token reuse, read-only scope, disconnected app, SSRF-guarded metadata URLs). It removes every client and token it created.

`npm run design:smoke` tests designed slides: previews (valid, off-canvas text, off-brand color and font), a hostile slide (scripts, frames, remote images, CSS `@import` and `url()`) that must make **zero** requests to a local catcher both in preview and in a saved render, mixed carousels, `get_slide_source`, assets, layouts (fill values escaped), and that the templates are unchanged (`npx tsx scripts/render-check.ts --check`).

## Designed slides

Besides the four templates, agents can design a slide themselves: `{ "kind": "design", "html": "…", "css": "…" }` on a 1080×1350 canvas. The studio adds the **brand layer**: your fonts, every brand color as a CSS variable (`--primary`, `--paper`, `--ink`, `--marker`…), type scale, spacing and radius variables, utility classes (`mark`, `.key`, `.chip`, `.card`, `pre.editor` with highlighting…) and the chrome (handle + `n / total`, option `chrome`). `ground` picks paper, primary or dark. The brand guide (`get_brand_guide`) teaches agents all of it with examples.

The loop: `get_design_system` → write HTML/CSS → `preview_slide` → fix what the checks report → save with `create_carousel` / `update_slides` / `edit_slide`. Checks: text or images off the canvas block the save; outside the 64 px safe area, clipped text, overlap with the footer, text under 24 px, non-brand fonts, off-palette colors, more than one marker and low contrast are warnings, shown as a badge on the slide in the studio. Good designs can be saved as **layouts** (`{{placeholders}}`) and reused with `{ "kind": "design", "layout": "big-number", "fill": { … } }`.

Agent HTML runs in the server's browser, so rendering is locked down: page JavaScript off, every network request blocked except `data:` and your own Blob store, a CSP, and the HTML/CSS is sanitized (no scripts, frames, forms, event handlers, remote URLs or `@import`). Agent CSS is scoped to the slide and can't move the slide box or cover the chrome.

## Slide format

```json
[
  { "kind": "cover", "hook": "Stop installing *date picker* libraries.", "sub": "Your browser already ships one." },
  { "kind": "content", "title": "Why it beats a *library*", "points": ["Native picker on every phone", "Ships zero JavaScript"] },
  { "kind": "code", "file": "date-input.html", "diff": true, "code": "- npm install react-datepicker\n+ <input type=\"date\">", "caption": "*Zero KB* added." },
  { "kind": "cta", "hook": "Save this for your *next form*." }
]
```

`*phrase*` is the highlighter (one per slide), `` `code` `` is inline code. Diff lines start with `- ` or `+ `.

## Brand packs

The repo ships a neutral default pack (`brand-pack/default`, OFL fonts). To use your own brand, open **Brand** and import a design-system `tokens.json` (a `color.tokens` list, optional `type.families` and `type.fonts`), its README and woff2 fonts, or run:

```bash
npm run brand:import -- path/to/design-system --name "My brand" --handle "@me" --label "Tip" --roles '{"primary":"brand-green"}'
```

Slides paint with **roles** (`primary`, `paper`, `ink`, `marker`, `code-bg`, …). If your token names differ, map them in `roles`. Fonts are stored in your database and only used by the renderer, which keeps commercial font licenses that forbid public redistribution intact.

## Security notes

- The UI is protected by a single password (signed, httpOnly session cookie). The MCP endpoint uses per-agent bearer keys stored as SHA-256 hashes.
- Rendered PNGs are public Blob URLs under unguessable paths.
- Web connectors use OAuth 2.1 (see "Web apps"): PKCE S256, single-use 60-second codes, exact redirect URI matching (port ignored only for loopback), refresh rotation with reuse detection, audience-bound tokens, and a consent screen that shows the client's real redirect host.

## Stack

Next.js 16 · React 19 · Drizzle ORM · Neon Postgres · Vercel Blob · `mcp-handler` + MCP SDK v2 · Playwright + `@sparticuz/chromium` · Zod 4

## License

MIT. Default fonts: Plus Jakarta Sans and JetBrains Mono, SIL Open Font License (see `brand-pack/default/fonts`).
