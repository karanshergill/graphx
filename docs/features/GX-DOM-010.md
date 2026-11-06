# GX-DOM-010 — static recon over observed JavaScript bodies

Status: implemented  
Release target: GraphX 0.3.x

## Operator intent

JS recon starts with the *contents* of observed JavaScript responses in
Caido's local data and extracts endpoints, GraphQL operations, storage keys,
postMessage usage, and dangerous DOM sinks. Both **Scan JS** and
`GET /js-recon` are passive by default. Missing source maps referenced by
observed bundles are fetched only after a one-scan opt-in in the GraphX UI.

## Semantics

- Extraction lives in `shared/src/jsRecon.ts` as pure, unit-tested functions
  (`extractJsRecon`, `mergeJsRecon`, `extractSourceMapRecon`). Regex-based, not
  AST parsing: endpoints built by string concatenation are missed, and string
  literals that merely look like paths can be false positives. Documented
  trade-off. Quoted strings and template literals are both scanned; for
  template literals the `${...}` interpolations are preserved in the output
  (parameter positions stay visible, e.g. `${BASE_URL}/audio_upload_url`).
- Each deduplicated endpoint, GraphQL operation, storage key, sink name, and
  postMessage lead carries one representative `evidence[]` entry: kind/value,
  1-based line/column in the JS body or source-map `sourcesContent`, asset path,
  optional original module path, and a Caido request ID only for captured
  bundle/map responses (inline maps use the bundle's ID). Original source
  modules take priority over minified bundles; ties are stable across sweep
  order. A live-fetched map has no captured ID, so it has no History/Replay
  pivot.
- The backend sweep (`services/jsRecon.ts`) pages the GraphQL `requests`
  connection (scope-pinned, case-insensitive host match including explicit
  ports, `%.js`/`%.mjs`, status < 400, newest first), dedupes by full
  URL including scheme, port, path, and query (cache-busted variants and
  HTTP/HTTPS responses remain distinct), and fetches bodies via
  `request(id) → response.raw` (base64 raw HTTP; body
  starts after the first CRLFCRLF) in batches of 16 parallel requests. It
  merges per-bundle extractions with `mergeJsRecon`. Note: the plugin SDK's
  `sdk.requests.query()` helper returned zero items for filters that match
  via GraphQL — the sweep deliberately uses `sdk.graphql.execute` instead
  (same pattern as `agentapi/query.ts`).
  A captured `304` revalidation is skipped before URL deduplication, so an
  earlier `200` for that URL can still supply the JS or source-map body.
- The sweep pages all matching observed JS and map responses without an
  artificial candidate ceiling. Response bodies are processed in batches of
  16. `truncated` indicates a pagination stall or inconsistent empty page;
  in that case later references may still be undiscovered. Large estates can
  take time and use substantial local resources even in passive mode.
- Source maps (`%.map`, status < 400) are parsed as JSON: `sources` feeds the
  module tree (`sourceModules`), and every `sourcesContent` entry (original
  unminified source) goes through the same extraction and is merged into the
  findings. `sourceMaps` lists the observed map paths — the exploitation lead
  list. Maps that answered 4xx/5xx are listed separately as
  `sourceMapsBlocked`: they exist but bodies are forbidden — bypass leads.
- Beyond passive data: every scanned bundle's last `//# sourceMappingURL=` is
  resolved against the bundle URL with `new URL` (relative, root-relative,
  protocol-relative, or same-host absolute; dot segments normalized, query
  and port preserved for the fetch). Inline
  `data:…;base64` maps are decoded in place (`sourceMapsInline`). The operator
  can opt in to actively fetching missing map references for **one** scan in
  the UI. By default the opted-in run attempts **all discovered, in-scope**
  missing maps; an operator may instead set a 1–20 request cap. Each send is
  checked against the selected Caido scope and spaced by 1,000–60,000 ms
  (default 2,000 ms). Repeated active scans cannot overlap or bypass the
  cross-run delay. There is no zero-delay setting or active agent-API route.
  The panel reports the discovered missing-reference count and active send,
  failure, and out-of-scope counts. An exhaustive attempt is not a guarantee
  of a fetched map: 4xx responses, transport errors, invalid JSON, and
  out-of-scope URLs can remain unfetched. Successful maps land in
  `sourceMapsFetched`; blocked responses join `sourceMapsBlocked`. Only
  opted-in scans send target traffic.
- Every active run writes a project-scoped SQLite audit start record before
  scanning, then records each target URL **before** sending it, plus its
  response/failure and a run completion record. If an audit write fails,
  further target requests are not sent. Interrupted runs retain their last
  recorded event. `GET /js-recon/audit` returns recent entries filtered by
  current project, selected scope, and host; URLs can contain sensitive query
  strings, so the endpoint remains loopback-only.
- Findings persist per project+host in SQLite (`js_recon` table), same
  pattern as domain marks.
- Endpoint noise is dropped at extraction and again at merge: static asset
  extensions (`.js`, `.css`, fonts, images, media, archives, `.map`, `.wasm`
  — query strings tolerated), bundler dev-server internals (`/node_modules/`,
  `/@vite/`, `/@fs/`, `/@react-refresh`), and namespace/telemetry hosts
  (`w3.org`, `schemas.xmlsoap.org`, `schema.org`, Google Analytics/Tag
  Manager, `connect.facebook.net`, `bat.bing.com`, `*.ingest.sentry.io`).
  Deliberately kept: `.json`/`.xml`/`.txt` paths, localhost URLs, and other
  third-party URLs. Every read goes through a fresh sweep (`scan` →
  `mergeJsRecon`), so unfiltered rows stored by older versions are replaced
  on the next scan.

## Routes and API

| Surface | Shape |
| --- | --- |
| `GET /js-recon?host=<hostname>&scope=<id\|name>` | Passive local sweep; `{ project, scope, host, generatedAt, bundlesScanned, missingMapReferences, sourceMapsScanned, sourceMaps[], sourceMapsBlocked[], sourceMapsFetched[], sourceMapsInline[], sourceModules[], truncated, endpoints[], graphqlOperations[], storageKeys[], postMessageHandlers, postMessageCalls, sinks{}, evidence[] }`. Legacy `throttle` and active-fetch flags are rejected. |
| `GET /js-recon/audit?host=<hostname>&scope=<id\|name>` | `{ project, scope, host, events[] }`, newest first, at most 100 events. Each event has `runId`, `time`, `scopeId`, `host`, `requestBudget` (`"all"` means uncapped), `delayMs`, `type`, and optional `url`, `statusCode`, `outcome`. |
| Plugin API `getJsRecon(host, scopeId?, options?: { active?: { delayMs, maxRequests? } })` | `Result<JsReconFindings>` with `missingMapReferences` and optional `activeRecon` run summary; only an explicit `active` option enables live requests. Omitting `maxRequests` attempts every discovered in-scope missing map. |

- Selection panel: Scan/Rescan stays passive until the operator checks an
  active-fetch consent box for that run; the default active mode attempts all
  discovered in-scope missing maps. A separate optional request-limit toggle
  enables a 1–20 cap. The minimum-delay input is always enforced. Consent and
  the limit toggle clear after each attempt and context change. Active results
  display sent, failed, skipped-out-of-scope, cap and audit run ID. The panel
  also shows representative lead source locations and copy-as-URLs endpoints,
  observed / blocked / live-fetched / inline source-map lists, and truncation
  notice. For leads with a captured request ID, **History** scrolls to its
  captured row for inspection; **Replay** opens an unsent request draft. The
  list can expand beyond its first 50 entries.
- Recon results are cached per host in the page and cleared on project/scope
  change. In-flight responses from an earlier context cannot repopulate it.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| R1 | Pure, tested extraction | `shared/src/jsRecon.ts` | `jsRecon.test.ts` (source locations, origins, and merge precedence) |
| R2 | Complete, paginated local response sweep and explicitly opted-in, scope-checked live source-map requests | `services/jsRecon.ts` | No static candidate ceiling; a newer `304` does not hide an older captured `200` for the same JS/map URL (regression test); live Caido scan confirmed JS fallback; default active scan attempts all missing in-scope maps; passive calls send no target traffic |
| R3 | Per-project persistence | `repositories/jsRecon.ts` | live: row in plugin `data.db` `js_recon` (2026-08-26) |
| R4 | Passive agent route and read-only audit route | `GET /js-recon`, `GET /js-recon/audit` in `agentapi/routes.ts` | GET with legacy active flags rejected; active requests only from UI |
| R5 | UI panel | `DomainGraphPage/Container.vue` | vue-tsc; build; Caido 0.59 passive scan: one captured bundle, one endpoint, one missing map |
| R6 | Captured source provenance and native Caido pivots | `shared/src/jsRecon.ts`, `services/jsRecon.ts`, `DomainGraphPage/Container.vue` | Model tests for multiline positions, source-map priority and no fabricated live-map ID; typed frontend build. |
| R7 | Per-run consent, rate control, optional cap, and persistent audit | `DomainGraphPage/Container.vue`, `services/jsRecon.ts`, `repositories/jsRecon.ts` | Exhaustive/optional-cap, rate and fail-closed tests plus UI smoke |
