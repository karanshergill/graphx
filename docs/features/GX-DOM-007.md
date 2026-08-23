# GX-DOM-007 — agent-queryable HTTP API

Status: implemented and verified live  
Release target: GraphX 0.3.x

## Operator intent

Agents (scripts, hunting copilots) must be able to query GraphX data over HTTP
the same way they query Caido itself — GraphX must not be a UI-only silo.

## Semantics

- The backend plugin runs a minimal HTTP/1.1 responder over a raw LLRT TCP
  listener (`net.createServer`), bound to **127.0.0.1:8771**. Loopback-only =
  same trust level as the local project database; **no auth in v1** (documented
  decision). Port registry: 8080 Caido, 8766 race plugin, 8771 GraphX, 9222 CDP.
- All routes are GET and return JSON; errors are `{ "error": string }` with
  400 (bad scope/request) or 404 (no route). Read-only: no mutations.
- Data is rebuilt server-side through backend `sdk.graphql.execute` plus the
  shared package's pure logic (`buildDomainGraph`, `groupAssetsByHost` — the
  asset module moved from frontend to `shared/src/domainGraph/assets.ts` so
  both sides use one implementation).

## Routes (verified live 2026-08-08, against a production estate)

| Route | Response | Verified |
| --- | --- | --- |
| `GET /health` | `{ ok, version }` | ✓ |
| `GET /marks` | `{ project, marks[] }` | ✓ 3 marks |
| `GET /domains?scope=<id\|name>` | `{ project, graph: DomainGraphSnapshot }` | ✓ full graph |
| `GET /assets?scope=` | `{ requestsScanned, truncated, hostsWithJs, hosts{host: HostAssets} }` | ✓ 4293 req → **3006 after the 2026-08-12 status/content guard** (phantom 4xx/HTML rows removed), 22 hosts |
| `GET /brief?scope=` | composite: project, scope, stats, per-host `{hostname, depth, observed, marked, js, maps}`, marks | ✓ 385 hosts |

`?scope=` accepts a scope id or name (case-insensitive); omitted with exactly
one scope = that scope; otherwise 400 listing available scopes.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| GX-DOM-701 | TCP listener inside the plugin runtime, loopback only, never crashes the plugin on listen errors. | `backend/agentapi/server.ts` | Live `/health` curl after hot-install; error handler warns only. |
| GX-DOM-702 | Minimal HTTP/1.1 responder with routing and JSON errors. | `server.ts` | 404 on unknown route; 400 with scope list on bad scope. |
| GX-DOM-703 | Server-side graph rebuild identical to the UI's. | shared `buildDomainGraph` via backend `graphql.execute` | `/domains` output matches UI data (372 entries, 385 nodes). |
| GX-DOM-704 | One shared asset-grouping implementation for frontend and backend. | `shared/src/domainGraph/assets.ts` | Tests moved to shared; `/assets` matches UI counts. |
| GX-DOM-705 | Composite hunt brief as one session-start call. | `/brief` route | Live output shows stats + marked + js/maps per host. |

## Not part of this increment

- Mutations, auth, non-loopback binding, streaming/subscriptions.
- Coverage stats / first-seen tracking (hangs off this API in a later increment).
