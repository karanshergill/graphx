# GX-DOM-005 — per-domain JS asset association

Status: implemented  
Release target: GraphX 0.3.0

## Operator intent

See which observed domains have JavaScript bundles and source maps associated
with them in captured traffic, so JS-heavy attack surface (bundles, chunk
files, leaked `.map` files) is visible on the domain graph and listable per
host without leaving Caido.

## Data source (validated against a live production estate, 2026-08-06)

- `requests(scopeId, filter)` with HTTPQL `{ code }`. Verified live:
  - `req.host.eq:"api.example.com"` → thousands of requests.
  - `req.path.like:"%.js"` → thousands of requests project-wide; `"%.map"` → hundreds.
  - `req.ext.eq:"js"` returns 0 — the ext field does not match; do not use.
  - `req.path.regex:...` is rejected ("Invalid HTTPQL").
  - Status/content guards (added 2026-08-12 after review found ~20% phantom rows):
    `resp.code.lt:400` drops non-served responses (~20% phantom rows on the
    validation estate), and
    `resp.raw.ncont:"ontent-Type: text/html"` drops HTML masquerading as JS
    (block/login/fallback pages). `resp.raw.cont/ncont` search the
    stored raw response case-insensitively; `resp.header.*`, `resp.length.*`,
    `resp.path.regex`, `not`, and `!` do not exist in this HTTPQL version.
- One paginated sweep (`first: 500`, cursor pagination, at most 100,000
  candidates; a cursor-stagnation guard stops and flags pathological loops),
  newest-first (`order: CREATED_AT DESC`); `truncated` signals a limit or
  pagination stall. `JS_ASSETS_HTTPQL` matches `.js`, `.mjs`, `.map`, or
  captured `text/javascript`/`application/javascript` MIME text, with the
  existing status and HTML guards. HTTPQL searches response bodies too, so
  paths without those suffixes require a second check of the actual captured
  `Content-Type` header before being grouped. Only those candidates need
  local raw-response reads (at most 16 in parallel); the frontend SDK
  returns decoded HTTP text, whereas backend GraphQL returns base64 HTTP.
  No per-host count fan-out or target requests.
- A `requestCount` probe on the same filter returns a `snapshot` token; the
  full sweep only re-runs when the token changes (checked on each manual
  graph sync).
- If the scope, manual sync, or page activation changes during a probe, the
  latest request is queued once and checked after the in-flight probe settles.
  Old scope/page results are discarded; sweeps never overlap.

## Semantics

- A **bundle** has an observed `.js`/`.mjs` path or a captured response with
  `text/javascript`/`application/javascript` in its actual `Content-Type`
  header, even at an extensionless path. A **map** ends `.map` (so `.js.map`
  counts as a map, never a bundle). Path suffix matching is case-insensitive
  and ignores query strings; `.json` without a JavaScript MIME header does
  not match. A MIME-looking string in the response body is never sufficient.
- Bundles are deduped by path per host with a request count and the latest
  observed response status. `hasMap` pairs a bundle with an observed
  `<path>.map` request on the same host — no probing, no target traffic.
- The **JS assets** toolbar toggle mutes hosts with no observed bundles and
  adds a `· N` bundle-count suffix to labels of hosts that have them. It is a
  view concern: no layout restart, no ingestion change; it yields to
  hover/selection and connection-path emphasis. Combined with **Marked only**
  the two compose into a single emphasis mode: marked hosts and JS hosts stay
  prominent (with count suffixes), everything else fades, and the Marked-only
  hard filter is not applied.
- Selecting a host lists bundles (path, request count, last status, `map`
  badge) 50 at a time in the selection panel. **Show next** and **Previous**
  page through every discovered bundle without extra requests; changing the
  host, scope, or asset sweep resets the view to the first page. **Copy URLs**
  writes every distinct captured bundle URL for that host across all pages,
  with its HTTP(S) scheme, non-default port, and query string intact. It never
  invents an HTTPS URL when the captured origin is unavailable.
- Expand a bundle to see each captured URL separately. **History** locates
  that URL's captured request row in Caido; select the row to inspect its
  request and response. **Replay** opens an unsent draft of that request.
  If a URL was revalidated with `304`, its most recent `2xx` capture is
  preferred for the pivot so the earlier response body remains available.
  Captures without a known URL have no History or Replay pivot.
- Structural parents simply have no assets and render as before.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| GX-DOM-501 | Read JS/map requests from the local project only; zero target traffic. | `assets/caidoRequests.ts` (read-only `requests`/`requestCount`) | Live HTTPQL validation log; no egress in harness run. |
| GX-DOM-502 | One paginated sweep grouped by host; snapshot-token staleness guard. | `caidoRequests.ts`, `useDomainAssets.ts` | Typecheck; harness run with mocked SDK. |
| GX-DOM-503 | Correct bundle/map classification incl. `.js.map` priority and non-JS exclusion. | `shared/src/domainGraph/assets.ts` | `assets.test.ts` covers suffix fallback, MIME-confirmed paths, map priority, and body-only MIME decoys. |
| GX-DOM-504 | Toggle mutes JS-less hosts and suffixes counts, on both renderers. | sigma `nodeReducer`, canvas `draw()` | Harness screenshot diff; installed UI inspection. |
| GX-DOM-505 | Per-host bundle list with map badge, status, copy URLs. | `DomainGraphPage` selection panel | Harness DOM assertions; installed UI inspection. |
| GX-DOM-506 | Lifecycle: reload on scope change and manual graph sync; release on exit. | `useDomainAssets` | Deferred snapshot/sweep tests cover scope switches, manual sync, and page re-entry; installed UI navigation smoke. |
| GX-DOM-507 | Show captured JavaScript at extensionless paths without target refetches. | `JS_ASSETS_HTTPQL`, `caidoRequests.ts`, `agentapi/query.ts` | Decoded-raw frontend regression; Caido 0.59 asset API and UI displayed `/assets/entry` paired with `/assets/entry.map`, excluding text/plain `/assets/decoy`. |
| GX-DOM-508 | Copy actual captured JS asset URLs without losing HTTP scheme, non-default ports, or query variants. | `shared/src/domainGraph/assets.ts`, `caidoRequests.ts`, `agentapi/query.ts`, `DomainGraphPage` | `assets.test.ts` covers distinct origins and queries; installed Caido 0.59 `/assets?scope=1` and UI clipboard both returned `http://localhost:4177/assets/entry?build=2` and `http://localhost:4178/assets/entry?build=3` from one bundle row. |
| GX-DOM-509 | Open a specific captured JS URL in History or as an unsent Replay draft, preferring a successful capture over `304` revalidation. | `assets.ts`, `caidoRequests.ts`, `agentapi/query.ts`, `DomainGraphPage` | `assets.test.ts` verifies per-URL request IDs and revalidation preference; isolated Caido 0.59 API mapped `build=one` to the `200` capture rather than newer `304`, History located its row, and Replay opened the `build=two` request without sending. |
| GX-DOM-510 | Browse all discovered bundles without rendering the entire host at once. | `DomainGraphPage` selection panel and `graphx.css` | Isolated Caido 0.59 with 103 captured `.js` files showed 1–50, 51–100, and 101–103; Previous returned to page two, host deselection/reselection reset to page one, and the final bundle retained History/Replay actions. |

## Not part of this increment

- Probing for unrequested `.map` files (generates target traffic); added separately for on-demand JS recon in GX-DOM-010.
- Response-body `sourceMappingURL` analysis (request meta carries no body); added separately in GX-DOM-010.
