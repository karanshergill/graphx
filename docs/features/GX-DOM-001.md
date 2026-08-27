# GX-DOM-001 — scoped Sitemap domain graph

Status: implemented  
Approved: 2026-08-04  
Release target: GraphX 0.1.0

## Operator intent

Display all domains and subdomains observed in the current program's Caido Sitemap, filter them through a selectable program scope, and show their parent-domain relationships in an interactive Obsidian-style graph. The implementation must remain modular and update during an active hunt without generating target traffic.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| GX-DOM-001 | Register GraphX as a native full-page Caido page. | `frontend/src/index.ts`, `DomainGraphPage` | Package manifest contains frontend and backend; installation smoke test. |
| GX-DOM-002 | Read Sitemap domain roots for the explicitly selected Caido scope. | `adapters/caidoSitemap.ts` | Typed build; installed UI scope test. |
| GX-DOM-003 | Apply allow rules, deny rules, wildcard semantics, and hostname normalization before graph construction. | `shared/src/domainGraph/scope.ts`, `hostname.ts` | `scope.test.ts`, `build.test.ts`. |
| GX-DOM-004 | Deduplicate equivalent Sitemap roots while retaining their Caido entry IDs. | `shared/src/domainGraph/build.ts` | `build.test.ts`. |
| GX-DOM-005 | Connect each node only to its nearest present DNS-suffix parent, and never synthesize an out-of-scope parent. | `shared/src/domainGraph/build.ts` | `build.test.ts`. |
| GX-DOM-006 | Render nodes as an organic force graph with pan, zoom, drag, select, hover, and neighborhood emphasis. | Graphology model, renderer factory, Sigma/WebGL primary, Canvas 2D fallback | Production build and installed UI smoke test in a WebGL-disabled browser. |
| GX-DOM-007 | Track live Sitemap events as pending changes without rebuilding per event. | `caidoSitemap.ts`, `useDomainGraph.ts` | Subscription cleanup review; sync-badge smoke test. |
| GX-DOM-008 | Prevent stale project or scope responses from crossing context boundaries. | `useDomainGraph.ts`, backend project event | Generation-token and lifecycle review. |
| GX-DOM-009 | Distinguish Sitemap-observed nodes from in-scope structural parents without claiming DNS status. | shared types, page legend and selection panel | Model tests and installed UI inspection. |
| GX-DOM-010 | Generate no target traffic. | Read-only Caido APIs only | Caido traffic comparison during smoke test. |
| GX-DOM-011 | Release browser, worker, observer, iterator, timer, and Caido-listener resources on route exit and unmount. | route activity bridge, renderer, canvas component, composable, adapter | Lifecycle review and navigation smoke test. |
| GX-DOM-012 | Keep Caido access, orchestration, graph rules, components, and rendering replaceable. | feature and workspace boundaries | Architecture review, `knip`, dependency-direction review. |
| GX-DOM-013 | Follow Caido's light and dark modes, including live changes, without leaking global CSS or retaining an inactive observer. | scoped theme bridge, CSS variables, renderer palette observers | Theme unit tests and installed dark/light/route-exit smoke test. |

## Acceptance dataset

Given the observed entries `example.com`, `api.stage.example.com`, a duplicate uppercase/trailing-dot transport variant, an explicitly denied host, and an out-of-scope host, the graph must:

- Produce one observed node per normalized in-scope hostname.
- Produce `example.com → stage.example.com → api.stage.example.com` when all suffixes are allowed.
- Mark `stage.example.com` structural when it was not observed directly.
- Exclude the denied and foreign hosts.
- Produce stable node, edge, depth, and ordering results across repeated builds.

## Not part of this increment

- DNS resolved/unresolved classification.
- HTTP reachability or liveness probing.
- Source-map discovery, minting state, or source-host edges.
- Browser fullscreen and collapsible fullscreen toolbar controls.
- Graph persistence, annotations, editing, export, or collaboration.

Those items require separate operator approval and feature specifications. The architecture reserves extension seams but does not implement them pre-emptively.
