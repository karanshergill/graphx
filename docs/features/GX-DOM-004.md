# GX-DOM-004 — persistent domain marks and connection paths

Status: implemented  
Release target: GraphX 0.2.0

## Operator intent

Mark a domain — alone or with every subdomain beneath it — directly from the
graph, keep those marks across Caido restarts, and optionally highlight the
entire path that connects marked domains through their shared ancestors. Marks
are hunting annotations owned by GraphX, stored per Caido project, and never
generate target traffic.

## Semantics

- Right-clicking the **selected** node opens a context menu: **Mark domain**, **Mark domain +
  N subdomains** (whole descendant subtree), **Unmark domain**, **Unmark domain
  + subdomains**. Right-clicking any other node does nothing — select it first.
  The same actions are keyboard-reachable: `M` toggles the
  selected domain, `Shift+M` marks it with its subdomains.
- Marks are keyed by normalized hostname, stored in the plugin's SQLite
  database (`domain_marks` table) scoped to the current Caido project. Scope
  changes never clear marks; a marked host outside the selected scope simply
  does not render.
- Marked nodes render in the marker color (`--graphx-marked-node`, Caido
  success accent) in both renderers, appear in the legend, and are counted in
  the toolbar statistics.
- **Marked only** (toolbar bookmark toggle) is a view projection: it retains
  marked nodes plus their ancestor chains and drops everything else. It never
  narrows ingestion, the snapshot, or the stored marks.
- **Connection paths** (toolbar route toggle, enabled once at least one mark
  exists) computes the union of every marked node's ancestor chain. Because the
  domain graph is a forest of parent-domain relationships, that union is the
  unique minimal connector: path edges render in the path accent
  (`--graphx-path-edge`) and non-path nodes and edges are muted. With a single
  mark it shows that node's full lineage to its root. It composes with the
  depth projection and the Marked-only filter; hover/selection emphasis still
  takes precedence while active.
- Both toggles are view state. They are not persisted and reset on route exit.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| GX-DOM-401 | Persist marks per project in plugin SQLite; survive restarts. | `backend/repositories/marks.ts` (`sdk.meta.db()` + `domain_marks` migration) | Typed build; reinstall round-trip: marks survive plugin and Caido reload. |
| GX-DOM-402 | Typed API: list/add/remove, marks-changed event. | `shared/api.ts`, `shared/events.ts`, `backend/api/marks.ts`, `services/marks.ts` | Typecheck; event received after each mutation. |
| GX-DOM-403 | Validate hostnames before storage; reject malformed input silently. | shared `normalizeHostname` in the repository | Lint/typecheck; invalid entries never reach the table. |
| GX-DOM-404 | Right-click context menu with mark/unmark, single or subtree. | Sigma `rightClickNode`, canvas `contextmenu`, `MarkContextMenu` | Installed UI smoke test on both renderers. |
| GX-DOM-405 | Keyboard parity: `M` toggle, `Shift+M` subtree mark. | `GraphCanvas` keydown → page handler | Installed UI smoke test. |
| GX-DOM-406 | Marked color + legend + stats count. | palette `--graphx-marked-node`, legend, toolbar stats | Installed UI inspection in dark and light modes. |
| GX-DOM-407 | Marked-only projection keeps ancestor chains; pass-through when empty. | `marking/domainMarks.ts` `projectMarkedSubgraph` | Unit tests; installed toggle smoke test. |
| GX-DOM-408 | Connection-path highlight = union of marked ancestor chains; mutes the rest. | `collectConnectionPath`, renderer reducers/draw | Unit tests (shared ancestor, disconnected trees, empty); installed UI inspection. |
| GX-DOM-409 | Generate no target traffic from any marking or path action. | All data via local plugin DB and in-memory projections | Traffic comparison during smoke test. |
| GX-DOM-410 | Release listeners and menu state on route exit. | `useDomainMarks` stop, menu `onBeforeUnmount` | Navigation smoke test. |

## Acceptance dataset

For `example.com → stage.example.com → {api,static}.stage.example.com` plus a
separate root `other.com`:

- Marking `api.stage.example.com` and `static.stage.example.com` then enabling
  Connection paths highlights exactly `api`, `static`, `stage`, `example.com`
  and the three connecting edges; `other.com` is muted.
- Marked only with only `static.stage.example.com` marked shows `static`,
  `stage`, `example.com` and hides `api` and `other.com`.
- Unmarking `example.com` + subdomains removes all marks in that tree and
  leaves `other.com` marks untouched.
- Marks persist across a Caido restart and are absent in a different project.

## Not part of this increment

- Mark categories, colors per mark, notes, or export/import.
- Persisting the toggle states or menu position.
- Path computation across non-parent relationships (none exist yet).
