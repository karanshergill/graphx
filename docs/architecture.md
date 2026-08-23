# GraphX architecture

## Design goal

GraphX is organized around domain modules so later entity types and relationships can be added without coupling Caido data access, graph derivation, view projection, or rendering. The current release implements scope-filtered Sitemap domains, their DNS-suffix relationships, persistent per-project domain marks with an optional connection-path highlight, per-host JavaScript asset association from local request data, and a loopback HTTP API that exposes all of it to agents as JSON.

## Data flow

```text
Caido project + scopes
          │
          ├── typed backend API ───────────────┐
          │                                    │
Caido Sitemap root query + subscriptions       │
          │                                    │
          ▼                                    ▼
  caidoSitemap adapter                 useDomainGraph
          │                                    │
          └──────── SitemapDomainEntry[] ──────┤
                                               ▼
                                      buildDomainGraph
                                               │
                                               ▼
                                      DomainGraphSnapshot
                                               │
                                               ▼
                                         Vue page state
                                               │
                                               ▼
                                        renderer factory
                                               │
                                              ┌─────────────┴─────────────┐
                                              ▼                           ▼
                                         Sigma/WebGL              Canvas 2D fallback
```

No arrow in this flow reaches a target. Caido's local project database is the only observation source.

## Package boundaries

### Shared

`packages/shared/src/domainGraph` contains the authoritative rules for this feature:

- Host normalization and validation.
- Exact Caido wildcard matching for `*` and `?`, with deny rules taking precedence.
- Stable domain-node and relationship identifiers.
- Deduplication of transport variants.
- In-scope structural-parent derivation.
- Deterministic depth, statistics, and output ordering.

The module has no Vue, Sigma, browser, Caido runtime, or network dependency. It can be tested entirely with sanitized fixtures.

### Backend

`packages/backend` exposes typed project context, emits project lifecycle changes, owns GraphX's durable annotations, and serves the agent HTTP API. Domain ingestion does not need durable plugin storage because the Caido Sitemap is already the durable source of truth for that data.

The agent API (`backend/agentapi/`) runs a minimal HTTP/1.1 responder over an LLRT TCP listener bound to `127.0.0.1:8771`. It rebuilds the domain graph and asset groupings server-side via backend `sdk.graphql.execute` plus shared pure logic, exposing `/health`, `/marks`, `/domains`, `/assets`, `/api-map` (per-host route templates via shared `buildApiMap`), and `/brief` as read-only JSON for agents.

Domain marks are the first GraphX-owned data: `backend/repositories/marks.ts` stores them in the plugin SQLite database from `sdk.meta.db()` (table `domain_marks`, keyed by project id and normalized hostname), behind the service/API layering (`api → services → repositories`). Mark changes emit a typed `domainMarks:changed` event.

Further data owned by GraphX, such as annotations or observations not represented by Caido, must use the same project-scoped SQLite pattern rather than browser storage.

### Frontend

`packages/frontend/src/features/domainGraph` is divided into four layers:

- `adapters`: typed Caido Sitemap query and subscription integration.
- `composables`: lifecycle, scope selection, race cancellation, burst debouncing, and reconciliation.
- `components`: page and canvas presentation.
- `rendering`: one Graphology model, ForceAtlas2 layout, a capability-selected Sigma/WebGL or Canvas 2D renderer, interaction handling, theme handling, and resource disposal.

The frontend theme bridge mirrors Caido's document-level `data-mode` attribute onto the CSS-scoped GraphX root. This is required because the PostCSS prefixer intentionally rewrites `:root` selectors to the plugin root. The bridge synchronizes before display, observes live mode changes only while the GraphX route is active, and disconnects on route exit. Both renderers observe the scoped root and redraw their palette after a mode change.

Both renderers consume only the view model (`DomainGraphView`); neither knows how Caido stores domains. The renderer factory prefers Sigma and selects Canvas 2D when WebGL is unavailable, so locked-down or software-rendered operator environments still display the graph without changing the data adapter or domain model.

## Relationship semantics

For an observed `api.stage.example.com`, GraphX walks DNS suffixes:

```text
example.com → stage.example.com → api.stage.example.com
```

A suffix is included only if the selected scope independently permits that hostname. This prevents an allowed exact host from causing an out-of-scope parent to appear. If the apex is excluded, the first permitted suffix becomes a visual root. GraphX does not guess registrable domains from a public-suffix list.

Node state is intentionally narrow:

- **Observed:** Caido Sitemap contains the normalized host.
- **Structural:** the host is an allowed suffix required to connect observed nodes.

DNS resolution, reachability, HTTP liveness, source maps, and source-host relationships are not inferred by this increment.

## Live-update guarantees

GraphX subscribes to Caido's typed Sitemap create, update, and delete streams for the selected scope. Domain events are collapsed into one refresh after 250 ms. A five-second reconciliation query runs only while the GraphX route is active, covering subscription interruption or an event arriving during startup. Snapshot revision comparison prevents unchanged reconciliations from restarting layout.

Every asynchronous refresh has a generation token. A response from an old project or scope is discarded and subscriptions are replaced when context changes. Caido retains plugin page bodies during navigation, so route activity explicitly starts and stops ingestion in addition to Vue's unmount cleanup. Timers, iterators, observers, the layout worker, and active renderer resources are released when GraphX becomes inactive.

## Extension seams

New functionality should enter through one of these seams:

1. Add a pure entity or relationship module in `shared`.
2. Add a Caido observation adapter in the relevant frontend or backend feature.
3. Merge typed snapshots through a graph-composition service.
4. Add renderer styles and controls for the newly approved states.

Do not put parsing or Caido queries in Vue components, do not put product rules in Sigma reducers, and do not make target requests as a rendering side effect.
