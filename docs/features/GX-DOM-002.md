# GX-DOM-002 — maximum visible domain depth

Status: **removed in 0.3.0** — the operator retired the control; the graph always shows all depths. This document remains as the historical record of the increment.  
Approved: 2026-08-04  
Release target: GraphX 0.1.0

## Operator intent

Allow the operator to reduce graph density by showing only domain nodes from the visual root through a selected maximum depth, without narrowing Caido Sitemap ingestion or risking missed observations during a hunt.

## Semantics

- `All` is the default and displays the complete current domain snapshot.
- Numeric options run from `0` through the snapshot's maximum depth.
- Selecting `N` displays nodes whose computed depth is less than or equal to `N`.
- A relationship is displayed only when both endpoint nodes are visible.
- The authoritative live snapshot remains complete. Depth selection is a frontend projection only and does not alter the Caido query, scope, subscriptions, reconciliation, or stored data.
- The toolbar must distinguish the number of visible nodes from the total tracked nodes whenever a filter is active.
- A scope change resets the projection to `All`; a live update preserves a still-valid numeric selection.

Maximum-depth filtering is used instead of exact-depth filtering because it preserves the parent chain and avoids presenting disconnected subdomains.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| GX-DOM-201 | Provide an accessible `Max depth` selector with `All` and every available level from `0…N`. | `DomainGraphPage`, `useDomainGraphDepth` | Typed production build and installed pointer UI smoke test. |
| GX-DOM-202 | Display nodes at `depth ≤ N` and relationships whose endpoints are both visible. | `shared/domainGraph/project.ts` | Projection unit tests and installed depth `0`, `1`, and `All` inspection. |
| GX-DOM-203 | Keep the complete live snapshot and ingestion pipeline independent from the selected visual depth. | Projection runs after `useDomainGraph` | Architecture review and five-second live reconciliation smoke test. |
| GX-DOM-204 | Preserve valid depth selection across reconciliations and reset it to `All` on scope change. | `useDomainGraphDepth` | Composable unit tests and installed reconciliation smoke test. |
| GX-DOM-205 | Show visible versus tracked node counts while filtered. | Toolbar statistics | Installed UI reported `8/318` at depth `0` and `143/318` at depth `1`. |
| GX-DOM-206 | Generate no target traffic when selecting or changing depth. | Pure in-memory projection | Installed smoke test requested only local Caido. |

## Acceptance dataset

For the chain `example.com → stage.example.com → api.stage.example.com` plus a separate root:

- `All` and maximum depth `2` show all four nodes and both relationships.
- Depth `0` shows only the two roots and no relationships.
- Depth `1` shows both roots plus `stage.example.com` and its parent relationship.
- Repeated projection is deterministic and does not mutate the source snapshot.

## Not part of this increment

- Exact-depth-only filtering.
- Per-root or per-branch depth controls.
- Persisting the selected depth across Caido sessions.
- Changing crawler, Sitemap, or DNS discovery depth.
