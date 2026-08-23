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
  example path, in-sitemap flag, last seen, and a Copy URL button.
- Data loads lazily per host through the typed plugin bridge
  (`sdk.backend.getApiMap`) and is cached per host for the session. Loading,
  error, and renderer-failure (e.g. no WebGL) states are all visible.
- Domain-mode features (marks, paths, JS emphasis, search) stay in the domain
  view; the drill view has only its own minimal controls.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| GX-DOM-901 | One typed `getApiMap` bridge shared with the HTTP route. | `shared/api.ts`, `backend/api/apiMap.ts`, shared `buildHostApiMap` | Typecheck; `/api-map` output unchanged after refactor. |
| GX-DOM-902 | Trie + deterministic layout, pure and tested. | `shared/domainGraph/routeTree.ts` | `routeTree.test.ts` (4 tests; caught two wrong expectations — param kinds stay distinct, leaf-y uniqueness only). |
| GX-DOM-903 | Static-layout sigma canvas with status-colored endpoints and hover labels. | `features/routeTree/renderer.ts` | Harness data-flow run; live UI inspection (requires WebGL). |
| GX-DOM-904 | Drill in/out via Enter, panel button, breadcrumb, Escape; per-host cache. | `DomainGraphPage`, `useApiMap` | Harness assertions; live UI smoke test. |
| GX-DOM-905 | Renderer failure never leaves a blank pane. | RouteTreeCanvas error emit + drill error state | Code review; error branch rendered in drill canvas. |

## Not part of this increment

Canvas-2D fallback for the drill view (sigma requires WebGL — documented),
filters/editing inside the drill view, route marking, whole-scope map,
OpenAPI export UI.
