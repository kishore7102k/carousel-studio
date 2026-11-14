# Phase 2: OAuth 2.1 so web agents can connect (ChatGPT, Claude.ai, Gemini)

**Prerequisite:** Phase 1 (`docs/phase-1-agent-tools.md`) is complete: scopes (`read` / `write` / `admin`), the `defineTool` helper, and the activity log exist. Do not start this phase before that.

**Goal:** ChatGPT (custom MCP connector / developer mode), Claude.ai (custom connector, web/desktop/mobile) and the Gemini app (Connected Apps → custom MCP) can connect to `https://<app>/api/mcp` by URL only, sign in with the studio owner's password, get consented scopes, and use every Phase 1 tool. Existing API keys (`ks_…` bearer headers for Claude Code, Codex, Cursor, Antigravity, scripts) keep working unchanged.

The studio itself becomes a small **OAuth 2.1 authorization server** and the MCP endpoint a **protected resource**. Single owner: the "user" who consents is whoever knows `STUDIO_PASSWORD` (existing session cookie). No new npm dependencies: use Web Crypto, opaque tokens, Postgres.

Read `AGENTS.md` (Next.js 16) and this whole file first.

---

## 1. Standards to implement (and only these)

| Standard | What we serve |
| --- | --- |
| OAuth 2.1 (draft) | Authorization code + PKCE only. No implicit, no password grant. |
| PKCE (RFC 7636) | `code_challenge_method=S256` required. Reject `plain` and missing challenges. |
| Protected Resource Metadata (RFC 9728) | `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/api/mcp`: `{ resource: "<origin>/api/mcp", authorization_servers: ["<origin>"], scopes_supported: ["read","write","admin"], bearer_methods_supported: ["header"] }`. Use `protectedResourceHandler` / `generateProtectedResourceMetadata` from `mcp-handler`. |
| Authorization Server Metadata (RFC 8414) | `GET /.well-known/oauth-authorization-server` (also serve the same JSON at `/.well-known/openid-configuration`, some clients probe it): `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none","client_secret_post","client_secret_basic"]`, `scopes_supported`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`. |
| Issuer identification (RFC 9207) | Every authorization response (success and error) includes `iss=<issuer>`. **ChatGPT only uses its stable redirect URI when this is supported.** |
| Resource Indicators (RFC 8707) | Accept `resource` on authorize and token requests (ChatGPT sends it on both). If present it must equal `<origin>/api/mcp` (normalize trailing slash); else `invalid_target`. Store the audience on the token; the MCP verifier rejects tokens whose audience is not this resource. |
| Dynamic Client Registration (RFC 7591) | `POST /oauth/register`: accept `client_name`, `redirect_uris` (required), `grant_types`, `response_types`, `token_endpoint_auth_method`, `scope`, `logo_uri`, `client_uri`. Return `client_id` (+ `client_secret` only when auth method ≠ `none`), `client_id_issued_at`, echoed metadata. |
| Client ID Metadata Documents (MCP CIMD draft) | If `client_id` is an `https://` URL, fetch it as the client's metadata (instead of a registered client). Validate that the document's `client_id` equals the URL and use its `redirect_uris` and `client_name`. Claude.ai and ChatGPT prefer this when advertised. |
| Token Revocation (RFC 7009) | `POST /oauth/revoke` (token + optional hint). Always 200. |
| Bearer usage (RFC 6750) | MCP 401s carry `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp"` (use `withMcpAuth`'s `resourceMetadataPath`), 403 + `error="insufficient_scope"` for scope failures. |

## 2. Data model (Drizzle, then `npm run db:push`)

```
oauth_clients   id uuid pk, client_id text unique, secret_hash text null, name text, redirect_uris text[],
                token_auth_method text, logo_uri text null, client_uri text null,
                source text ('dcr'|'cimd'), metadata_fetched_at timestamptz null, created_at, last_used_at
oauth_codes     code_hash text pk, client_id text, redirect_uri text, code_challenge text, scopes text[],
                resource text, expires_at timestamptz, used_at timestamptz null, created_at
oauth_tokens    id uuid pk, client_id text, kind text ('access'|'refresh'), token_hash text unique,
                scopes text[], resource text, family_id uuid, expires_at timestamptz,
                revoked_at timestamptz null, created_at, last_used_at
```
Indexes on `oauth_tokens(token_hash)`, `oauth_tokens(family_id)`, `oauth_codes(expires_at)`.

Store every secret as **sha256 hashes only** (reuse `sha256` from `src/lib/auth.ts`). Token formats: access `sat_<32 random bytes base64url>`, refresh `srt_…`, codes `sac_…`, DCR secrets `scs_…`. Access TTL 1 hour, refresh TTL 60 days, code TTL 60 seconds.

## 3. Endpoints (route handlers under `src/app/`)

| Route | Notes |
| --- | --- |
| `/.well-known/oauth-protected-resource[/api/mcp]` | GET + OPTIONS (CORS via `metadataCorsOptionsRequestHandler`). |
| `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | GET + OPTIONS, CORS `*`. Issuer = `studioUrl('')` (no trailing slash). |
| `/oauth/register` | POST JSON, CORS. Validate redirect URIs: `https://` only, except loopback `http://localhost|127.0.0.1|[::1]` (any port). Max 10 URIs, 2 KB name. Rate limit: max 20 registrations per hour per IP (simple DB count). Unused clients (no tokens) older than 30 days are deleted lazily on each registration. |
| `/oauth/authorize` | **Page** (`src/app/oauth/authorize/page.tsx`), protected by the existing session: no session → redirect to `/login?next=<full authorize URL>` (login's `next` handling must allow this path with its query string). Validate everything BEFORE showing consent: client exists (or CIMD fetch succeeds), `redirect_uri` exactly matches a registered one (loopback: match ignoring port), `response_type=code`, S256 challenge present, `resource` valid, scopes ⊆ supported (default `read write` if omitted; `admin` only if explicitly requested). If `client_id` or `redirect_uri` is invalid, show an error page and do NOT redirect. Other errors redirect with `error`, `error_description`, `state`, `iss`. |
| consent UI | Shows client name, its redirect host (e.g. `chatgpt.com`), source (registered / metadata URL), and a checkbox per requested scope (owner may untick). Buttons Allow / Deny. Server action re-validates all params, creates the code, redirects to `redirect_uri?code=…&state=…&iss=…`. Deny → `error=access_denied`. CSRF: server actions + `sameSite=lax` session cookie; also embed a signed hash of the request params and check it on submit. |
| `/oauth/token` | POST `application/x-www-form-urlencoded`, CORS. Client auth per the client's method (`none` for public clients). `authorization_code`: code exists, unused, unexpired, same client and redirect_uri, `S256(code_verifier) == code_challenge`, resource matches; mark used atomically (`UPDATE … SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL RETURNING`). **Code reuse → revoke every token issued from that code's family.** Returns `{ access_token, token_type: "Bearer", expires_in, refresh_token, scope }`. `refresh_token`: rotate (new refresh, old revoked); **presenting an already-rotated refresh token revokes the whole family**; scopes may only narrow. Errors per RFC 6749 §5.2 JSON with 400/401. `Cache-Control: no-store`. |
| `/oauth/revoke` | POST, revokes access or refresh (and the family for refresh). |

Update `src/proxy.ts` so `/.well-known/*`, `/oauth/token`, `/oauth/register` and `/oauth/revoke` bypass the UI password gate. `/oauth/authorize` stays gated (that is the login).

### CIMD fetching (SSRF-safe)
`https:` only; resolve DNS and refuse private, loopback, link-local and metadata IP ranges; 3 s timeout; max 8 KB; `content-type` must be JSON; no redirects followed; cache the parsed document in `oauth_clients` (source `cimd`) for 24 h and refetch after.

## 4. MCP verification

`withMcpAuth` verifier in the MCP route:
1. `ks_…` → existing API key path (unchanged).
2. `sat_…` → look up the token hash, not revoked, not expired, `resource` equals this server's resource, `kind = access`; update `last_used_at` (at most once a minute). Return `{ token, clientId: <client name>, scopes }`.
3. Otherwise `undefined` → 401 with the `WWW-Authenticate` challenge.

Activity log actor for OAuth calls: the client name, e.g. `ChatGPT` or `Claude`.

## 5. UI (Agents page → "Connections")

- One list with both kinds: **API keys** (existing) and **Connected apps** (OAuth clients that hold live tokens): name, redirect host, scopes, connected at, last used, **Disconnect** (revokes all its tokens; keep the client record).
- A "Connect a web app" card with the MCP URL and per-client steps:
  - **ChatGPT**: Settings → Apps & Connectors → Advanced → Developer mode on → Create / "Add custom MCP server" → URL `https://<app>/api/mcp`, Authentication **OAuth** → sign in → Allow.
  - **Claude.ai**: Settings → Connectors → Add custom connector → URL → Connect → sign in → Allow.
  - **Gemini app**: Settings → Connected apps → Add custom app (MCP) → URL → sign in → Allow (availability depends on Google's region/plan rules).
- The `create_key`, `list_connections`, `revoke_access` MCP tools from Phase 1 now include OAuth connections (admin scope).

## 6. Tests (required)

`scripts/oauth-smoke.ts` (`npm run oauth:smoke`) against the dev server, all over HTTP:
1. Discovery: both well-known documents return the fields above; the MCP endpoint without auth returns 401 with the `resource_metadata` challenge.
2. DCR → authorize → consent → token exchange with PKCE → call `list_carousels` over MCP with the access token → success. Drive the login and the Allow click with `playwright-core` (already a dependency; launch the local browser the same way `src/lib/render/render.ts` does), capturing the `code` from the redirect to a loopback `redirect_uri` (`http://127.0.0.1:<port>/callback` served by the script). This tests the real consent UI, not a shortcut.
3. Negative cases, each must fail correctly: wrong `code_verifier`; reused code (and the first token gets revoked); wrong `redirect_uri`; `plain` PKCE; wrong `resource`; expired access token; refresh rotation reuse revokes the family; read-only token calling a write tool → scope error; revoked connection → 401.
4. CIMD: serve a metadata document from a local test route only in development (`/api/dev/cimd-test`, disabled when `NODE_ENV=production`) and complete the flow with that URL as `client_id`; and SSRF guard rejects `https://127.0.0.1/...` and `http://` URLs.
5. Cleanup in `finally`: delete test clients, codes and tokens.

Then manual end-to-end checks on the deployed app (record results in the Progress log):
- MCP Inspector (`npx @modelcontextprotocol/inspector`) OAuth flow.
- Claude.ai custom connector: connect, list carousels, create one, add a note, disconnect.
- ChatGPT developer mode connector: same.
- Gemini app custom connected app: same, if the account is eligible.

## 7. Security checklist (must all be true)

- Tokens, codes and client secrets are only ever stored hashed; never logged; never returned after creation.
- Exact redirect URI matching (loopback port exception only); no open redirects from `/oauth/authorize`.
- PKCE S256 mandatory; codes single-use, 60 s.
- Tokens are audience-bound to `/api/mcp`.
- Refresh rotation with reuse detection; disconnect revokes everything for a client.
- `Cache-Control: no-store` on token responses; CORS only on metadata, register, token and revoke routes.
- Login `next` parameter only allows same-origin relative paths.
- Consent shows the real redirect host so a malicious client name cannot impersonate ChatGPT/Claude.

## 8. Out of scope

Multi-user accounts, third-party identity providers (Google/GitHub login), JWT access tokens, REST/OpenAPI for Custom GPT actions (phase 4).

## 9. Progress log (keep this updated)

After finishing each item, tick it here and commit code + this file together. If you stop mid-item, add a one-line note under it.

- [x] 1. Schema: `oauth_clients`, `oauth_codes`, `oauth_tokens`; `npm run db:push`
  - Note: `oauth_codes.family_id` added (the token family a code creates) so code reuse can revoke that family. `token_hash` is unique, which is its index.
- [x] 2. `src/lib/oauth/*`: token/code generation + hashing, PKCE verify, scope + resource helpers, `studioUrl`-based issuer
- [x] 3. Discovery: protected resource + authorization server metadata routes (+ CORS); MCP 401 challenge via `resourceMetadataPath`
- [ ] 4. DCR `/oauth/register` with validation + rate limit + lazy cleanup
- [ ] 5. CIMD fetcher with SSRF guard + cache
- [ ] 6. `/oauth/authorize` page + consent UI + signed-params check + `iss` in all responses; login `next` supports it
- [ ] 7. `/oauth/token` (code + refresh, rotation, reuse detection) and `/oauth/revoke`
- [ ] 8. MCP verifier accepts `sat_` tokens with audience check; activity actor = client name
- [x] 9. Proxy bypass for public OAuth routes
- [x] 10. Agents page: Connected apps list + Disconnect + "Connect a web app" instructions; Phase 1 access tools include OAuth connections
- [ ] 11. `scripts/oauth-smoke.ts` + `npm run oauth:smoke` passing; `npm run mcp:smoke` still passing
- [ ] 12. README: client support table (header keys vs OAuth), OAuth notes; build + lint clean
- [ ] 13. Manual checks after deploy: MCP Inspector, Claude.ai, ChatGPT, Gemini (write the result of each here)

## 10. Definition of done

All progress items ticked, both smoke scripts pass locally, and at least Claude.ai and ChatGPT complete connect → create carousel → note → disconnect on the deployed app. Small focused commits; never commit `.env*`, keys or brand font files. Do not push or deploy without the maintainer's go-ahead.
