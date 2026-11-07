# GX-DOM-008 — per-host API map (agent API)

Status: implemented and verified live  
Release target: GraphX 0.3.x

## Operator intent

Give agents a Swagger-like map of any observed host — routes, not raw URLs —
queryable like Caido itself, built passively from captured traffic.

## Source-of-truth rule (2026-08-14 rework)

**The Caido Sitemap is the structural base truth; proxy history only enriches.**
The route first reconstructs the host's deduplicated endpoint set from the
sitemap tree (all matching domain roots — transport variants included —
`depth: ALL`, `REQUEST`-kind entries, paths rebuilt from parent chains), then
joins request statistics onto those endpoints. A request whose path matches no
sitemap endpoint is kept but flagged `inSitemap: false`.

## Semantics

- `GET /api-map?host=<hostname>&scope=<id|name>` on `127.0.0.1:8771`. Host is
  normalized/validated (400 on missing/invalid host or host absent from the
  sitemap). Request sweep: case-insensitive `req.host.like` including explicit
  ports, newest-first, capped at 100,000 requests with a cursor-stagnation
  guard; `truncated` signals either limit.
- **Templating** over the sitemap path set: segments collapse to `{id}` on
  known patterns (numeric, UUID, ULID, ISO date, ≥16-char digit-containing
  token) and to `{param}` when a position exceeds **5 distinct literal values**
  across otherwise-identical paths. Request paths join templates by exact
  collapsed match, else most-specific literal match.
- Each route: `template, examplePath, inSitemap, requests, methods{}, statuses{},
  queryKeys[], firstSeen, lastSeen, evidence[]`. `evidence[]` contains up to
  eight captured request samples (one newest request per method/status, stable
  ties), each with `requestId`, method, path, optional status and timestamp.
  A sample's optional `url` preserves its captured HTTP(S) scheme, non-default
  port, concrete path, and query string. Missing origin metadata leaves `url`
  absent rather than inventing an HTTPS origin. Sitemap-only routes have no
  evidence; counts still include all swept requests. Selection is deterministic
  and input-order independent.
- Response: `project, scope, host, generatedAt, truncated, sitemapEndpoints,
  requestsScanned, routeCount, routes[]`.

## Live verification (2026-08-14, against a production estate)

**922** sitemap endpoints, **5,726** requests scanned → **318** templates on a
single production host; join is exact (0 orphans, 0 empty endpoints). Examples:
`/v1/assessments/{id}` → GET×5 + POST×1 merged into one template;
`/v1/recordings/{param}` → 200×49 / 403×160 (an authz boundary surfaced at a
glance).
Known limit: cardinality collapse can merge distinct sibling services sharing a
path shape — read `statuses`/`examplePath` before trusting such a template.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| GX-DOM-801 | Pattern + cardinality collapsing, deterministic. | `shared/domainGraph/apiMap.ts` | `apiMap.test.ts` (including order-independence and captured-request samples). |
| GX-DOM-802 | Sitemap-first structure: endpoints from the sitemap tree, stats joined from requests; orphans flagged. | `agentapi/query.ts` `readSitemapHostPaths`, `buildApiMap(sitemapPaths, requests)` | Live curl: 922 endpoints, 0 orphans. Tests for sitemap-only endpoints and `inSitemap:false`. |
| GX-DOM-803 | Route served read-only on the agent API with 400s for bad input. | `agentapi/routes.ts` `/api-map` | Live curl outputs above; 400 on missing/invalid/absent host. |
| GX-DOM-804 | Keep bounded, reproducible captured request IDs behind each route for native Caido pivots. | `apiMap.ts`, `agentapi/query.ts` | Model tests for mixed 200/403, sitemap-only and sample cap; backend query smoke with a captured ID. |
| GX-DOM-805 | Retain real captured URLs for representative route samples without replacing concrete paths with templates. | `apiMap.ts`, `agentapi/query.ts` | `apiMap.test.ts` covers retained-sample URL identity, encoded query values, default HTTPS port, and missing origins; isolated Caido `/api-map` returned captured HTTP URLs on port 4179. |

## Not part of this increment

Signal flags (authz-mix etc. — statuses already expose the raw signal),
unauth-header detection, OpenAPI YAML export, UI drill-down, whole-scope map.
