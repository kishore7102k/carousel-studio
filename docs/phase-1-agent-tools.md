# Phase 1: Full agent control over MCP

You are working in **Carousel Studio** (`studio/`), an open-source Next.js 16 app plus MCP server. Humans review social media carousels in the web UI; agents (Claude Code, Codex, Cursor, Antigravity, ChatGPT, Claude.ai, Gemini, scripts) edit them over MCP.

**Goal of this phase:** every action a human can take in the web UI must also be possible through MCP tools, with scoped permissions, tool safety annotations, soft delete and an activity log. OAuth is NOT part of this phase (phase 2).

Read this whole file before writing code. Then read `AGENTS.md` (Next.js 16 has breaking changes; its docs are in `node_modules/next/dist/docs/`).

---

## 1. Know the codebase first

| Path | What it is |
| --- | --- |
| `src/app/api/mcp/route.ts` | MCP server today: 11 tools, `createMcpHandler` + `withMcpAuth` from `mcp-handler` v2, MCP SDK v2 (`@modelcontextprotocol/server`), zod 4 |
| `src/lib/store.ts` | All data operations (Drizzle + Neon). UI server actions and MCP tools both call this. Keep it that way. |
| `src/lib/slides.ts` | Zod slide schema (`Slide`, `Slides`), `SLIDE_FORMAT_GUIDE` |
| `src/lib/brand.ts` | Brand pack in DB (`getBrand`, `saveBrand`, `resetBrand`, `roleColor`, `ROLES`) |
| `src/lib/auth.ts` | API keys (sha256-hashed, prefix `ks_`) and the UI password session |
| `src/lib/render/*` | Slide HTML templates + Playwright renderer + Blob upload. **Do not change the visual templates.** |
| `src/db/schema.ts` | Drizzle schema. Apply changes with `npm run db:push` |
| `src/app/(studio)/**` | UI pages; `src/app/actions.ts` = UI server actions |
| `scripts/` | `create-key.ts`, `import-brand.ts`, `render-check.ts` |

Known pitfalls in this project (do not reintroduce):
- `next.config.ts` has Cache Components OFF on purpose; pages use `export const dynamic = 'force-dynamic'`.
- Never re-export a server action through a `'use client'` file and then `.bind()` it in a server component (this crashed `/agents` before). Import server actions from their `'use server'` module.
- `params` / `searchParams` / `cookies()` / `headers()` are async (Promises).
- The DB client is `neon-http`: **no transactions**. Make concurrency-sensitive updates single atomic `UPDATE ... WHERE ... RETURNING` statements (see `claimRequest`).
- `getDb()` is lazy on purpose (build must work without env vars).
- Middleware is `src/proxy.ts` (renamed in Next 16). `/api/mcp` is excluded from the UI password gate and uses bearer auth.

## 2. Architecture changes

1. **Split the MCP server.** Keep `src/app/api/mcp/route.ts` thin. Move tool definitions to `src/lib/mcp/tools/{carousels,slides,render,requests,brand,access,compat}.ts` and a registry in `src/lib/mcp/server.ts`.
2. **One registration helper** that every tool goes through:
   ```ts
   defineTool(server, name, {
     title, description, inputSchema,            // z.object({...})
     scope: 'read' | 'write' | 'admin',
     annotations: { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint: false },
   }, handler)
   ```
   It must: check the caller's scopes (from `ctx.http?.authInfo.scopes`) and return an `isError` result `missing scope: write` when not allowed; catch errors and return `isError` with a readable message (never a stack trace); write an activity log row for every `write`/`admin` tool (actor = agent name, action = tool name, target carousel id if any, small JSON detail without base64 data).
3. **Scopes.** `admin` implies `write` implies `read`. Add `scopes text[] not null default '{read,write}'` to `api_keys`. `verifyApiKey` returns `{ name, scopes }`; `withMcpAuth`'s verifier returns `{ token, clientId: name, scopes }`.
4. **Soft delete.** Add `deleted_at timestamptz null` to `carousels`. Normal lists exclude trashed rows.
5. **Activity log.** New table `activity { id uuid pk, actor text, action text, carousel_id uuid null (fk, on delete set null), detail jsonb, created_at timestamptz default now() }`, index on `(carousel_id, created_at desc)`. UI server actions also log (actor = `'you'`).
6. **Public URL helper.** `studioUrl(path)` = `process.env.STUDIO_URL` or `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` or `http://localhost:3000`. Add `STUDIO_URL` to `.env.example`.

## 3. Tools (final set)

Conventions for ALL tools:
- Slide numbers in tool inputs/outputs are **1-based**. The DB `slideIndex` is 0-based: convert at the boundary.
- Every change to slides creates a **new version** from the **current** version and renders it (`render: false` skips rendering). Slide-editing tools accept optional `baseVersion`; if given and it is not the current version, fail with `stale: current version is N` (optimistic concurrency between agents).
- Validate full slides with the `Slide` zod schema after applying a patch.
- Return compact JSON (`JSON.stringify(x, null, 2)` in a text block). Include `url` (studio link) for carousels and `images` for renders.
- Descriptions are written for an LLM: say when to use the tool, what it changes, and limits. Keep the existing `get_brand_guide` workflow text and extend it.

| Tool | Scope | Annotations | Behavior |
| --- | --- | --- | --- |
| `get_brand_guide` | read | readOnly | (exists) workflow + slide format + brand README. Mention scopes and 1-based slides. |
| `list_carousels` | read | readOnly | (exists) add `query` (title ilike), `status`, `includeTrashed` (default false), `limit` (default 50). |
| `get_carousel` | read | readOnly | (exists) add `url`. Slides as JSON with 1-based `n` field added in output only. |
| `create_carousel` | write | — | (exists) |
| `update_carousel` | write | idempotent | Patch `title`, `number` (tipNumber), `status`. |
| `duplicate_carousel` | write | — | Copy a version (default current) into a NEW carousel as v1, optional `title`, renders. |
| `delete_carousel` | write | destructive | Soft delete (sets `deleted_at`). Reversible with `restore_carousel`. |
| `restore_carousel` | write | idempotent | Clears `deleted_at`. |
| `purge_carousel` | admin | destructive | Permanent delete; only allowed when already in trash. Also deletes its Blob images (`list({ prefix: 'carousels/<id>/' })` then `del(urls)` from `@vercel/blob`). |
| `set_current_version` | write | idempotent | Point the carousel at an existing version. |
| `compare_versions` | read | readOnly | `{ id, a, b }` → per slide: `added` / `removed` / `changed` with changed fields old→new. |
| `update_slides` | write | — | (exists) add `baseVersion`. |
| `edit_slide` | write | — | `{ id, slide: n, patch, note?, baseVersion?, render? }` shallow-merge patch into slide n; `kind` change allowed only if the result validates. |
| `insert_slide` | write | — | `{ id, at: n, slide }` insert before position n (n = count+1 appends). |
| `remove_slide` | write | destructive | `{ id, slide: n }`; refuse if it would leave fewer than 2 slides. |
| `move_slide` | write | — | `{ id, from, to }`. |
| `render_carousel` | write | idempotent | (exists) |
| `view_slides` | read | readOnly | (exists) also include the image URLs as text, because some clients do not show MCP image content. |
| `get_download_links` | read | readOnly | Image URLs of a version in order, plus file names `01.png`… |
| `list_requests` | read | readOnly | (exists) slides 1-based in output. |
| `get_request` | read | readOnly | One request with its carousel title and url. |
| `add_note` | write | — | `{ carouselId, slide: n, text, x?, y?, version? }` (x/y 0-1, default 0.5/0.5; version default current). Lets reviewer agents leave notes for other agents. |
| `request_carousel` | write | — | `{ prompt }` → new `kind: 'new'` request in the queue. |
| `claim_request` | write | idempotent | (exists) |
| `complete_request` | write | — | (exists) |
| `dismiss_request` | write | idempotent | open/claimed → dismissed. |
| `reopen_request` | write | idempotent | done/dismissed → open, clears claim fields and reply. |
| `get_brand` | read | readOnly | name, handle, labelPrefix, roles with resolved colors, font families/weights (**never** base64), readme. |
| `update_brand` | admin | idempotent | Patch name, handle, labelPrefix, readme, roles (validate role names against `ROLES`). |
| `import_brand` | admin | — | `{ tokens (object), readme?, fonts?: [{ family, weight, base64 }] }`, max 2 MB total base64, woff/woff2 only (check magic bytes `wOFF`/`wOF2`). |
| `reset_brand` | admin | destructive | Back to the bundled default pack. |
| `list_activity` | read | readOnly | `{ carouselId?, limit? }` newest first. |
| `list_connections` | admin | readOnly | API keys: id, name, scopes, createdAt, lastUsedAt (never hashes). |
| `create_key` | admin | — | `{ name, scopes }` → returns the key ONCE. |
| `revoke_access` | admin | destructive | Delete a key by id. Refuse to revoke the caller's own key. |
| `search` | read | readOnly | OpenAI-compatible: `{ query }` → `{ results: [{ id, title, url }] }` over carousel titles + slide text and request text. IDs: `carousel:<uuid>` / `request:<uuid>`. |
| `fetch` | read | readOnly | OpenAI-compatible: `{ id }` → `{ id, title, text, url, metadata }`; text = readable slide dump or request text. |

Also register:
- **Resource** `studio://brand-guide` (text/markdown) = same text as `get_brand_guide`.
- **Prompts** `make_carousel { topic }` (instructions to create a 5-8 slide carousel following the brand guide) and `handle_requests` (claim → fix → complete loop).

## 4. UI parity (small, reuse existing styles in `globals.css`)

- Agents page: scope selector (read / read+write / admin) when creating a key; show scopes per key.
- Gallery: a "Trash" filter (query `?trash=1`) listing trashed carousels with Restore and Delete forever (forever only from trash).
- Carousel page: Duplicate button; Delete now moves to trash; an "Activity" list (last 20) under the notes panel.
- UI server actions call the same store functions and write activity rows.

## 5. Tests and checks (required)

1. `scripts/mcp-smoke.ts` (`npm run mcp:smoke`, uses `dotenv -e .env.local` like other scripts): creates a temporary **admin** key directly in the DB, calls EVERY tool over HTTP against `STUDIO_URL` (default `http://localhost:3000/api/mcp`) with `Accept: application/json, text/event-stream` and `MCP-Protocol-Version: 2025-06-18`, asserts results, and verifies:
   - a `read` key gets `missing scope` on a write tool, and a `write` key on an admin tool;
   - `baseVersion` mismatch returns `stale`;
   - two different agents cannot both claim one request;
   - trash → restore → trash → purge works and purge outside trash is refused;
   - `get_brand` contains no base64.
   It deletes everything it created (carousels purged, keys revoked) even on failure (`try/finally`), and prints a pass/fail table.
2. `npm run build` and `npm run lint` pass with no new warnings.
3. No new npm dependencies. No changes to `src/lib/render/html.ts` output.
4. Update `README.md`: tools table, scopes, soft delete, activity log.

## 6. Out of scope

OAuth / ChatGPT, Claude.ai, Gemini web sign-in (phase 2), REST/OpenAPI (phase 4), template visual changes, multi-user accounts.

## 7. Progress log (keep this updated)

Work through these in order. **After finishing each item, tick it here and commit** (code + this file together), so another agent can resume exactly where you stopped. If you stop mid-item, add a one-line note under it saying what is done and what is left.

- [x] 1. Schema: `api_keys.scopes`, `carousels.deleted_at`, `activity` table; `npm run db:push`
- [x] 2. Auth: `verifyApiKey` returns scopes; MCP verifier passes them through
- [x] 3. `src/lib/mcp/server.ts` + `defineTool` helper (scope check, errors, activity log); route.ts made thin
- [x] 4. Move the 11 existing tools into `src/lib/mcp/tools/*` via `defineTool` (behavior unchanged + new params)
- [x] 5. Carousel tools: update, duplicate, delete/restore/purge, set_current_version, compare_versions
- [x] 6. Slide tools: edit_slide, insert_slide, remove_slide, move_slide, `baseVersion` on update_slides
- [ ] 7. Render tools: view_slides URLs, get_download_links
- [x] 8. Request tools: get_request, add_note, request_carousel, dismiss_request, reopen_request
- [x] 9. Brand tools: get_brand, update_brand, import_brand, reset_brand
- [x] 10. Access + activity tools: list_connections, create_key, revoke_access, list_activity
- [x] 11. Compat: search, fetch, `studio://brand-guide` resource, prompts
- [x] 12. UI parity: key scopes, Trash filter, Duplicate, Activity list, UI actions log activity
- [ ] 13. `scripts/mcp-smoke.ts` + `npm run mcp:smoke` passing
- [ ] 14. README updated; `npm run build` + `npm run lint` clean

## 8. Definition of done

- All tools above exist, are scope-checked, annotated, logged, and pass `npm run mcp:smoke` against the local dev server.
- UI parity items work.
- Build + lint clean. Small, focused commits. Do not commit `.env*`, keys, or any brand font files. Do not push or deploy; the maintainer reviews first.
