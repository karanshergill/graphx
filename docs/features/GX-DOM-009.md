# GX-DOM-009 — full-canvas API-map drill-down

Status: implemented  
Release target: GraphX 0.3.x

## Operator intent

Drill from a domain node into a full-canvas, tree-structured route map of that
host — a visual, Swagger-like view built on the same sitemap-first data as
`/api-map`.

## Semantics

- **Drill in:** `Enter` on the selected node, or **Open API map** in the
  selection panel. **Drill out:** the `← Domains` breadcrumb or `Escape`.
- The drill view renders the host's route templates as a segment trie (pure
  `buildRouteTree`, shared) with a deterministic tidy-tree layout (pure
  `layoutRouteTree` — depths as x, unique leaf y, no physics).
- Node encoding: intermediate segments in structural color, `{id}`/`{param}` in
  the path accent, endpoints sized by log(requests) and colored by status mix
  (has 4xx = warning accent, has 5xx = danger, else observed). Legend included.
- Selecting an endpoint opens a details panel: methods, statuses, query keys,
  example path, in-sitemap flag, last seen, and captured request samples.
  Each sample with a known origin has **Copy URL**, preserving its actual
  HTTP(S) scheme, non-default port, concrete path, and query string.
  **Copy route template** separately copies the relative template, such as
  `/api/users/{id}`, without inventing an origin. **History** navigates to and
  scrolls to the captured request row; **Replay** creates and opens an unsent
  draft from its ID. Sitemap-only endpoints have only the template to copy.
- Data loads lazily per host and scope through the typed plugin bridge
  (`sdk.backend.getApiMap`). **Refresh API map** bypasses the current host's
  cache and rebuilds from local captured data. **Sync domain graph** clears
  every cached API map and also reloads the open drill-down, if any.
  Project/scope changes invalidate cached maps; leaving the drill-down alone
  keeps them for quick reopening. Refresh clears the previous route selection,
  and results from superseded requests cannot restore an older map. Loading,
  error, and renderer-failure (e.g. no WebGL) states are all visible. Neither
  refresh control sends traffic to targets.
- In the drill view, the toolbar search matches route templates and concrete
  example paths, case-insensitively. Exact matches rank before prefixes and
  substrings; at most 25 suggestions are shown. `/` or `Ctrl/Cmd+K` focuses
  the search, arrow keys choose a result, and `Enter` centers that endpoint
  and opens its details. Clicking a suggestion does the same. `Escape` in
  the search clears it without leaving the map. Matching uses only the loaded
  routes, and the index updates when the API map is refreshed.
- Marks, connection paths, and JS emphasis remain domain-view controls.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| GX-DOM-901 | One typed `getApiMap` bridge shared with the HTTP route. | `shared/api.ts`, `backend/api/apiMap.ts`, shared `buildHostApiMap` | Typecheck; `/api-map` output unchanged after refactor. |
| GX-DOM-902 | Trie + deterministic layout, pure and tested. | `shared/domainGraph/routeTree.ts` | `routeTree.test.ts` (4 tests; caught two wrong expectations — param kinds stay distinct, leaf-y uniqueness only). |
| GX-DOM-903 | Static-layout sigma canvas with status-colored endpoints and hover labels. | `features/routeTree/renderer.ts` | Harness data-flow run; live UI inspection (requires WebGL). |
| GX-DOM-904 | Drill in/out via Enter, panel button, breadcrumb, Escape; per-host cache. | `DomainGraphPage`, `useApiMap` | Harness assertions; live UI smoke test. |
| GX-DOM-905 | Renderer failure never leaves a blank pane. | RouteTreeCanvas error emit + drill error state | Code review; error branch rendered in drill canvas. |
| GX-DOM-906 | Pivot from representative captured route requests without sending target traffic. | `DomainGraphPage`, Caido History/Replay SDK | Backend sample-ID smoke; typed frontend build. |
| GX-DOM-907 | Distinguish captured sample URL copies from relative route-template copies. | `DomainGraphPage`, route `evidence[].url` | Isolated Caido 0.59 clipboard returned `http://localhost:4179/api/users/42?view=full&next=%2Fsettings` for the GET sample, the POST sample's distinct URL, and `/api/users/{id}` for the template action. |
| GX-DOM-908 | Refresh local captured routes on demand and invalidate API map caches on graph Sync. | `useApiMap`, `DomainGraphPage` | Five lifecycle regressions cover explicit refresh, cached-selection races, Sync invalidation, refresh failure, and project changes. Isolated Caido 0.59 showed 2→3 routes with Refresh API map, 3→4 with Sync while open, and 4→5 after Sync and reopening; captured request count remained 5. |
| GX-DOM-909 | Search loaded route templates and example paths, with keyboard and pointer jumps to centered endpoint details. | `RouteSearch.vue`, `routeSearch.ts`, `RouteTreeCanvas`, route renderer | Search tests cover example/template matches, ranking, case folding, blanks, and the 25-result cap. Isolated Caido 0.59 centered `/api/orders/{id}` from `/api/orders/42`, opened a second result with arrow keys, scrolled to result 25, preserved the map on Escape, and found newly captured routes after Refresh without extra target traffic. |

## Not part of this increment

Canvas-2D fallback for the drill view (sigma requires WebGL — documented),
graph filters/editing inside the drill view, route marking, whole-scope map,
OpenAPI export UI.
