import { Buffer } from "buffer";

import { RequestSpec } from "caido:utils";
import {
  err,
  extractJsRecon,
  extractSourceMapRecon,
  findSourceMapRef,
  type JsReconExtraction,
  type JsReconFindings,
  mergeJsRecon,
  normalizeHostname,
  normalizeThrottleMs,
  ok,
  type Result,
} from "shared";

import { execute, resolveScope } from "../agentapi/query";
import type { JsReconRepository } from "../repositories";
import type { BackendSDK } from "../types";

const PAGE_SIZE = 200;
const FETCH_CONCURRENCY = 16;

type RequestNode = {
  id: string;
  path: string;
  query?: string;
  isTls?: boolean;
  port?: number;
};

type JsRequestPage = {
  requests: {
    edges: { cursor: string; node: RequestNode }[];
    pageInfo: { endCursor?: string; hasNextPage: boolean };
  };
};

type JsRequestBody = {
  request?: { response?: { raw?: string } };
};

// Dedupe/display key: path plus query, so cache-busted variants of the same
// path (`/app.js?v=a` vs `?v=b`) are scanned as distinct bodies.
type Candidate = { id: string; key: string; node: RequestNode };

// LIKE without wildcards is ASCII case-insensitive; the second clause also
// matches Host headers carrying an explicit port.
const buildFilter = (
  host: string,
  pathClause: string,
  statusClause: string,
): string =>
  `(req.host.like:"${host}" or req.host.like:"${host}:%") ` +
  `and ${pathClause} and ${statusClause}`;

const JS_PATH_CLAUSE = '(req.path.like:"%.js" or req.path.like:"%.mjs")';
const MAP_PATH_CLAUSE = '(req.path.like:"%.map")';
const STATUS_OK = "resp.code.lt:400";
const STATUS_BLOCKED = "resp.code.gte:400";

// `raw` is the base64-encoded raw HTTP response (status line, headers, body).
const decodeBody = (raw: string): string | undefined => {
  const text = Buffer.from(raw, "base64").toString("utf-8");
  const separator = text.indexOf("\r\n\r\n");
  if (separator === -1) return undefined;
  return text.slice(separator + 4);
};

const collectCandidates = async (
  sdk: BackendSDK,
  scopeId: string,
  filter: string,
): Promise<{ candidates: Candidate[]; truncated: boolean }> => {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let truncated = false;
  let after: string | undefined;

  for (;;) {
    const data = await execute<JsRequestPage>(
      sdk,
      "query($scopeId: ID, $filter: HTTPQLInput, $first: Int, $after: String, $order: RequestResponseOrderInput) { requests(scopeId: $scopeId, filter: $filter, first: $first, after: $after, order: $order) { edges { cursor node { id path query isTls port } } pageInfo { endCursor hasNextPage } } }",
      {
        scopeId,
        filter: { code: filter },
        first: PAGE_SIZE,
        order: { by: "CREATED_AT", ordering: "DESC" },
        ...(after === undefined ? {} : { after }),
      },
    );

    for (const edge of data.requests.edges) {
      const node = edge.node;
      const query = node.query ?? "";
      const key = query === "" ? node.path : `${node.path}?${query}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ id: node.id, key, node });
    }

    const { endCursor, hasNextPage } = data.requests.pageInfo;
    if (!hasNextPage || endCursor === undefined) break;
    // Loop-safety guard, not a budget: a non-advancing cursor would page
    // forever. Should never fire.
    if (endCursor === after) {
      sdk.console.warn(
        "GraphX JS recon sweep stopped: pagination cursor did not advance; results are truncated.",
      );
      truncated = true;
      break;
    }
    after = endCursor;
  }

  return { candidates, truncated };
};

const fetchBodyText = async (
  sdk: BackendSDK,
  id: string,
): Promise<string | undefined> => {
  let data: JsRequestBody;
  try {
    data = await execute<JsRequestBody>(
      sdk,
      "query($id: ID!) { request(id: $id) { response { raw } } }",
      { id },
    );
  } catch (error: unknown) {
    // A single unreadable body must not fail the whole sweep.
    sdk.console.warn(
      `GraphX JS recon: body fetch failed for request ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  const raw = data.request?.response?.raw;
  if (typeof raw !== "string") return undefined;
  return decodeBody(raw);
};

// Sequential batches of parallel fetches: fast enough for big sweeps without
// hammering the local GraphQL endpoint with an unbounded fan-out.
const forEachBatch = async (
  items: readonly Candidate[],
  fn: (item: Candidate) => Promise<void>,
): Promise<void> => {
  for (let index = 0; index < items.length; index += FETCH_CONCURRENCY) {
    await Promise.all(items.slice(index, index + FETCH_CONCURRENCY).map(fn));
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const originOf = (node: RequestNode, host: string): string => {
  const tls = node.isTls !== false;
  const port = node.port;
  const portSuffix =
    port === undefined || (tls && port === 443) || (!tls && port === 80)
      ? ""
      : `:${port}`;
  return `${tls ? "https" : "http"}://${host}${portSuffix}`;
};

// Resolve a sourceMappingURL reference against the bundle's own URL. `new
// URL` handles relative, root-relative, protocol-relative, and absolute
// refs and normalizes dot segments (`/a/../x.map` → `/x.map`). Returns
// undefined for cross-host or non-HTTP references (webpack://, file:, …).
// `path` is query/fragment-free so it compares cleanly with the observed
// and blocked path sets; `url` keeps the query (and any explicit port)
// for the live fetch.
const resolveMapUrl = (
  ref: string,
  bundle: RequestNode,
  host: string,
): { path: string; url: string } | undefined => {
  let resolved: URL;
  try {
    resolved = new URL(ref, `${originOf(bundle, host)}${bundle.path}`);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return undefined;
  }
  if (resolved.hostname.toLowerCase() !== host) return undefined;
  resolved.hash = "";
  return { path: resolved.pathname, url: resolved.toString() };
};

const pathOnly = (key: string): string => key.split("?", 1)[0] ?? key;

const buildHostJsRecon = async (
  sdk: BackendSDK,
  scopeId: string,
  host: string,
  fetchDelayMs: number,
): Promise<JsReconFindings> => {
  const normalized = normalizeHostname(host);
  if (normalized === undefined) throw new Error(`Invalid host "${host}".`);

  const extractions: JsReconExtraction[] = [];
  const sourceMaps: string[] = [];
  const sourceMapsBlocked: string[] = [];
  const sourceMapsFetched: string[] = [];
  const sourceMapsInline: string[] = [];
  const sourceModules = new Set<string>();
  // sourceMappingURL leads discovered in scanned bundles: path → fetch URL.
  const mapLeads = new Map<string, string>();
  let bundlesScanned = 0;
  let truncated = false;

  // The three candidate lists are independent; collect them concurrently.
  const [jsCandidates, mapCandidates, blockedCandidates] = await Promise.all([
    collectCandidates(
      sdk,
      scopeId,
      buildFilter(normalized, JS_PATH_CLAUSE, STATUS_OK),
    ),
    collectCandidates(
      sdk,
      scopeId,
      buildFilter(normalized, MAP_PATH_CLAUSE, STATUS_OK),
    ),
    collectCandidates(
      sdk,
      scopeId,
      buildFilter(normalized, MAP_PATH_CLAUSE, STATUS_BLOCKED),
    ),
  ]);
  truncated ||=
    jsCandidates.truncated ||
    mapCandidates.truncated ||
    blockedCandidates.truncated;

  await forEachBatch(jsCandidates.candidates, async (candidate) => {
    const text = await fetchBodyText(sdk, candidate.id);
    if (text === undefined) return;
    bundlesScanned += 1;
    extractions.push(extractJsRecon(text));

    const ref = findSourceMapRef(text);
    if (ref === undefined) return;
    if (ref.startsWith("data:")) {
      // Inline map: no fetch needed, decode in place.
      const comma = ref.indexOf(",");
      if (comma >= 0 && ref.slice(0, comma).includes(";base64")) {
        const inline = Buffer.from(ref.slice(comma + 1), "base64").toString(
          "utf-8",
        );
        const recon = extractSourceMapRecon(inline);
        if (recon !== undefined) {
          sourceMapsInline.push(candidate.key);
          for (const module of recon.sources) sourceModules.add(module);
          extractions.push(recon.extraction);
        }
      }
      return;
    }
    const lead = resolveMapUrl(ref, candidate.node, normalized);
    if (lead !== undefined) mapLeads.set(lead.path, lead.url);
  });

  await forEachBatch(mapCandidates.candidates, async (candidate) => {
    const text = await fetchBodyText(sdk, candidate.id);
    if (text === undefined) return;
    const recon = extractSourceMapRecon(text);
    if (recon === undefined) return;
    sourceMaps.push(candidate.key);
    for (const module of recon.sources) sourceModules.add(module);
    extractions.push(recon.extraction);
  });

  // Maps that answered 4xx/5xx: they exist but their bodies are blocked —
  // prime candidates for manual bypass attempts.
  const scannedPaths = new Set(sourceMaps.map(pathOnly));
  const blockedPaths = new Set<string>();
  for (const candidate of blockedCandidates.candidates) {
    const path = pathOnly(candidate.key);
    if (!scannedPaths.has(path) && !blockedPaths.has(path)) {
      blockedPaths.add(path);
      sourceMapsBlocked.push(path);
    }
  }

  // Actively fetch maps referenced by bundles but never observed in the
  // store. Scope-checked before every send; delay between sends is
  // caller-controlled (default: low-and-slow, 0 disables).
  const missing = [...mapLeads.entries()].filter(
    ([path]) => !scannedPaths.has(path) && !blockedPaths.has(path),
  );
  let firstSend = true;
  for (const [path, url] of missing) {
    try {
      const spec = new RequestSpec(url);
      if (!sdk.requests.inScope(spec, [scopeId])) continue;
      if (!firstSend && fetchDelayMs > 0) await sleep(fetchDelayMs);
      firstSend = false;
      const sent = await sdk.requests.send(spec);
      const code = sent.response?.getCode();
      const body = sent.response?.getBody();
      if (code === undefined || code >= 400 || body === undefined) {
        if (!blockedPaths.has(path)) {
          blockedPaths.add(path);
          sourceMapsBlocked.push(path);
        }
        continue;
      }
      const recon = extractSourceMapRecon(body.toText());
      if (recon === undefined) continue;
      sourceMapsFetched.push(path);
      for (const module of recon.sources) sourceModules.add(module);
      extractions.push(recon.extraction);
    } catch (error: unknown) {
      sdk.console.warn(
        `GraphX map fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    host: normalized,
    generatedAt: new Date().toISOString(),
    bundlesScanned,
    sourceMapsScanned: sourceMaps.length,
    sourceMaps: sourceMaps.sort(),
    sourceMapsBlocked: sourceMapsBlocked.sort(),
    sourceMapsFetched: sourceMapsFetched.sort(),
    sourceMapsInline: sourceMapsInline.sort(),
    sourceModules: [...sourceModules].sort(),
    truncated,
    ...mergeJsRecon(extractions),
  };
};

export type JsReconService = {
  scan: (
    host: string,
    scopeId?: string,
    throttleMs?: number,
  ) => Promise<Result<JsReconFindings>>;
};

export const createJsReconService = (
  sdk: BackendSDK,
  repository: JsReconRepository,
): JsReconService => ({
  scan: async (host, scopeId, throttleMs) => {
    try {
      if (normalizeHostname(host) === undefined)
        return err(`Invalid host "${host}".`);
      const project = await sdk.projects.getCurrent();
      if (project === undefined)
        return err("No Caido project is currently selected.");
      const scope = await resolveScope(sdk, scopeId);
      const findings = await buildHostJsRecon(
        sdk,
        scope.id,
        host,
        normalizeThrottleMs(throttleMs),
      );
      await repository.save(project.getId(), findings);
      return ok(findings);
    } catch (error: unknown) {
      return err(error instanceof Error ? error.message : String(error));
    }
  },
});
