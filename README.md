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
4. An agent claims it, calls `update_slides` (new version + render) and `complete_request` with a reply.
5. You approve and post.

## Deploy on Vercel

1. Fork this repo and import it in Vercel.
2. Add storage from the Vercel Marketplace: **Neon** (Postgres) and **Blob** (public store). Both set their env vars automatically.
3. Add env vars:

   | Variable | Value |
   | --- | --- |
   | `STUDIO_PASSWORD` | Password for the web UI |
   | `STUDIO_SESSION_SECRET` | 32+ random bytes, e.g. `openssl rand -hex 32` |

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

### Tools

| Tool | What it does |
| --- | --- |
| `get_brand_guide` | Workflow, slide format and the active brand's rules. Agents read this first. |
| `list_carousels`, `get_carousel` | Browse carousels, versions, images and requests. |
| `create_carousel`, `update_slides` | Write slides; every save is a new rendered version. |
| `render_carousel`, `view_slides` | Re-render, or get the PNGs back as images to check them. |
| `set_carousel_status` | draft → review → approved → posted. |
| `list_requests`, `claim_request`, `complete_request` | The human's queue, with 30-minute leases. |

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
- OAuth for web connectors (ChatGPT, Claude.ai) is not implemented yet.

## Stack

Next.js 16 · React 19 · Drizzle ORM · Neon Postgres · Vercel Blob · `mcp-handler` + MCP SDK v2 · Playwright + `@sparticuz/chromium` · Zod 4

## License

MIT. Default fonts: Plus Jakarta Sans and JetBrains Mono, SIL Open Font License (see `brand-pack/default/fonts`).
