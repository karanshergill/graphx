# GX-DOM-006 — domain and subdomain search

Status: implemented  
Release target: GraphX 0.3.x

## Operator intent

Find any domain or subdomain in a large scope graph quickly and jump the view
to it, without scrolling or hunting through hundreds of nodes.

## Semantics

- A toolbar search box matches against every node in the current snapshot
  (observed hosts and structural parents). Matching is case-insensitive;
  results rank exact match first, then prefix matches, then substring matches,
  alphabetical within each group, capped at 25.
- Results appear in a live dropdown: click or `↓`/`↑` + `Enter` picks one.
  `Enter` alone jumps to the top match. `Escape` clears the box and returns to
  the graph. `/` or `Ctrl/Cmd+K` focuses the box from anywhere on the page.
- Picking a match selects the node and centers the camera on it
  (`focusNode` on the renderer interface, implemented by both renderers
  through the existing selection pipeline). The query stays in the box so the
  operator can jump between successive matches.
- Search is a pure view concern over the in-memory snapshot: no Caido queries,
  no target traffic, and it does not alter marks, connection-path, JS-asset,
  or combined emphasis modes.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| GX-DOM-601 | Ranked matcher: exact > prefix > substring, case-insensitive, capped. | `search/domainSearch.ts` | `domainSearch.test.ts` (5 tests). |
| GX-DOM-602 | Jump selects and centers the node on both renderers. | `focusNode` in sigma + canvas renderers | Harness keyboard/jump assertion. |
| GX-DOM-603 | Live dropdown with mouse and full keyboard operation. | `components/DomainSearch` | Harness dropdown assertions. |
| GX-DOM-604 | Global `/` and Ctrl/Cmd+K focus shortcuts, page-active only. | `DomainGraphPage` document keydown | Harness shortcut assertion. |
| GX-DOM-605 | No new data source, no target traffic, no emphasis-mode interference. | In-memory snapshot only | Code review; no adapter changes. |

## Not part of this increment

- Fade-filtering the graph while typing.
- Search history or saved searches.
- Fuzzy/typo-tolerant matching (substring only).
