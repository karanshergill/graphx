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
- One paginated sweep (`first: 500`, cursor pagination, **uncapped**; a
  cursor-stagnation guard stops and flags pathological loops), newest-first
  (`order: CREATED_AT DESC` — so `lastStatus` is genuinely latest and any
  truncation cuts oldest history), `truncated: true` surfaced when it happens,
  with filter `(req.path.like:"%.js" or req.path.like:"%.mjs" or req.path.like:"%.map") and resp.code.lt:400 and resp.raw.ncont:"ontent-Type: text/html"`,
  grouped by host client-side. No per-host count fan-out.
- A `requestCount` probe on the same filter returns a `snapshot` token; the
  full sweep only re-runs when the token changes (checked on each graph
  refresh tick and the 5 s reconciliation).

## Semantics

- A **bundle** is an observed request path ending `.js` or `.mjs`; a **map**
  ends `.map` (so `.js.map` counts as a map, never a bundle). Matching is
  case-insensitive and ignores query strings. `.json` never matches.
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
- Selecting a host lists up to 50 bundles (path, request count, last status,
  `map` badge) in the selection panel, with a **Copy URLs** button that writes
  `https://<host><path>` lines to the clipboard.
- Structural parents simply have no assets and render as before.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| GX-DOM-501 | Read JS/map requests from the local project only; zero target traffic. | `assets/caidoRequests.ts` (read-only `requests`/`requestCount`) | Live HTTPQL validation log; no egress in harness run. |
| GX-DOM-502 | One paginated sweep grouped by host; snapshot-token staleness guard. | `caidoRequests.ts`, `useDomainAssets.ts` | Typecheck; harness run with mocked SDK. |
| GX-DOM-503 | Correct bundle/map classification incl. `.js.map` and `.json` exclusion. | `assets/domainAssets.ts` | `domainAssets.test.ts` (5 tests). |
| GX-DOM-504 | Toggle mutes JS-less hosts and suffixes counts, on both renderers. | sigma `nodeReducer`, canvas `draw()` | Harness screenshot diff; installed UI inspection. |
| GX-DOM-505 | Per-host bundle list with map badge, status, copy URLs. | `DomainGraphPage` selection panel | Harness DOM assertions; installed UI inspection. |
| GX-DOM-506 | Lifecycle: reload on scope change and refresh ticks; release on exit. | `useDomainAssets` | Composable review; navigation smoke test. |

## Not part of this increment

- Probing for unrequested `.map` files (generates target traffic).
- Response-body `sourceMappingURL` analysis (request meta carries no body).
- Drill-down into HTTP History from an asset row.
