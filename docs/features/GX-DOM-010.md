# GX-DOM-010 — static recon over observed JavaScript bodies

Status: implemented  
Release target: GraphX 0.3.x

## Operator intent

Frontend recon should not stop at "this host ships these bundles". GraphX
reads the *contents* of observed JavaScript responses (passively — Caido's
local data only) and extracts the attack surface the client reveals:
endpoints, GraphQL operations, storage keys, postMessage usage, and
dangerous DOM sinks. The agent queries this over the agent API; the human
sees it in the domain selection panel.

## Semantics

- Extraction lives in `shared/src/jsRecon.ts` as pure, unit-tested functions
  (`extractJsRecon`, `mergeJsRecon`, `extractSourceMapRecon`). Regex-based, not
  AST parsing: endpoints built by string concatenation are missed, and string
  literals that merely look like paths can be false positives. Documented
  trade-off. Quoted strings and template literals are both scanned; for
  template literals the `${...}` interpolations are preserved in the output
  (parameter positions stay visible, e.g. `${BASE_URL}/audio_upload_url`).
- The backend sweep (`services/jsRecon.ts`) pages the GraphQL `requests`
  connection (scope-pinned, case-insensitive host match including explicit
  ports, `%.js`/`%.mjs`, status < 400, newest first), dedupes by path+query
  (cache-busted variants of one path are scanned as distinct bodies), and
  fetches bodies via `request(id) → response.raw` (base64 raw HTTP; body
  starts after the first CRLFCRLF) in batches of 16 parallel requests. It
  merges per-bundle extractions with `mergeJsRecon`. Note: the plugin SDK's
  `sdk.requests.query()` helper returned zero items for filters that match
  via GraphQL — the sweep deliberately uses `sdk.graphql.execute` instead
  (same pattern as `agentapi/query.ts`).
- No budgets or caps: every observed bundle and source map is fetched,
  parsed, and merged in full; result lists are complete. `truncated` is
  reserved for the pagination-stall guard (loop safety; should never fire).
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
  `data:…;base64` maps are decoded in place (`sourceMapsInline`). Referenced
  maps that were never observed are fetched live through Caido
  (`sdk.requests.send`), scope-checked (`inScope`) and throttled — the delay
  between sends is caller-controlled: `throttle` (ms) on the agent route and
  plugin API, a panel input for the human; default 2000 ms (low-and-slow per
  standing orders), 0 disables. Successes land in `sourceMapsFetched`,
  failures join `sourceMapsBlocked`. Soft-200s (HTML fallback pages answering
  as 200) fail JSON parsing and are discarded silently. This is the only part
  of the sweep that sends traffic to the target.
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
| `GET /js-recon?host=<hostname>&scope=<id\|name>&throttle=<ms>` | `{ project, scope, host, generatedAt, bundlesScanned, sourceMapsScanned, sourceMaps[], sourceMapsBlocked[], sourceMapsFetched[], sourceMapsInline[], sourceModules[], truncated, endpoints[], graphqlOperations[], storageKeys[], postMessageHandlers, postMessageCalls, sinks{} }` |
| Plugin API `getJsRecon(host, scopeId?, throttleMs?)` | `Result<JsReconFindings>`; sweeps + persists |

- Selection panel gains a "JS recon" section: Scan/Rescan, throttle input
  (ms between live map fetches), endpoint list (first 50 + copy-as-URLs),
  GraphQL ops, storage keys, sink counts, postMessage counts, observed /
  blocked / live-fetched / inline source-map lists, truncation notice.
- Recon results are cached per host in the page and cleared on project/scope
  change.

## Requirements ledger

| ID | Requirement | Implementation | Acceptance evidence |
| --- | --- | --- | --- |
| R1 | Pure, tested extraction | `shared/src/jsRecon.ts` | `jsRecon.test.ts` (13 tests) |
| R2 | Uncapped passive body sweep | `services/jsRecon.ts` | live: mclass.amplify.com, 92 bundles + 8 maps, untruncated (2026-08-26) |
| R3 | Per-project persistence | `repositories/jsRecon.ts` | live: row in plugin `data.db` `js_recon` (2026-08-26) |
| R4 | Agent route | `GET /js-recon` in `agentapi/routes.ts` | live: `curl :8771/js-recon?host=mclass.amplify.com&scope=1` → 200 (2026-08-26) |
| R5 | UI panel | `DomainGraphPage/Container.vue` | vue-tsc; build |
