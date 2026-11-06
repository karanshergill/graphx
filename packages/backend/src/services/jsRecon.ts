import { Buffer } from "buffer";

import { RequestSpec } from "caido:utils";
import {
  err,
  extractJsRecon,
  extractSourceMapRecon,
  findSourceMapRef,
  type JsReconActiveOptions,
  type JsReconActiveSummary,
  type JsReconExtraction,
  type JsReconFindings,
  type JsReconScanOptions,
  mergeJsRecon,
  normalizeHostname,
  ok,
  type Result,
  validateActiveReconOptions,
} from "shared";

import { execute, resolveScope } from "../agentapi/query";
import type {
  JsReconAuditEvent,
  JsReconRepository,
} from "../repositories/jsRecon";
import type { BackendSDK } from "../types";

const PAGE_SIZE = 200;
const FETCH_CONCURRENCY = 16;

type ActiveRun = {
  projectId: string;
  options: JsReconActiveOptions;
  summary: JsReconActiveSummary;
  pacing: { lastSendAt?: number };
  audit: (
    event: Pick<JsReconAuditEvent, "type" | "url" | "statusCode" | "outcome">,
  ) => Promise<void>;
};

type RequestNode = {
  id: string;
  path: string;
  query?: string;
  isTls?: boolean;
  port?: number;
  response?: { statusCode: number };
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

// Keep path plus query for display and full URL for deduplication; bundles on
// different schemes or ports can lead to different maps.
type Candidate = { id: string; key: string; url: string; node: RequestNode };

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

// Keep only one page's request nodes in memory. Dedupe across pages by URL,
// but process bodies before requesting the next page.
const sweepCandidates = async (
  sdk: BackendSDK,
  scopeId: string,
  host: string,
  filter: string,
  visit: (candidate: Candidate) => Promise<void>,
): Promise<boolean> => {
  const seen = new Set<string>();
  const visitedCursors = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const data = await execute<JsRequestPage>(
      sdk,
      "query($scopeId: ID, $filter: HTTPQLInput, $first: Int, $after: String, $order: RequestResponseOrderInput) { requests(scopeId: $scopeId, filter: $filter, first: $first, after: $after, order: $order) { edges { cursor node { id path query isTls port response { statusCode } } } pageInfo { endCursor hasNextPage } } }",
      {
        scopeId,
        filter: { code: filter },
        first: PAGE_SIZE,
        order: { by: "CREATED_AT", ordering: "DESC" },
        ...(after === undefined ? {} : { after }),
      },
    );

    const candidates: Candidate[] = [];
    for (const { node } of data.requests.edges) {
      // A revalidation has no body; keep its URL available for an older 200.
      if (node.response?.statusCode === 304) continue;
      const query = node.query ?? "";
      const key = query === "" ? node.path : `${node.path}?${query}`;
      const url = new URL(key, originOf(node, host)).toString();
      if (seen.has(url)) continue;
      seen.add(url);
      candidates.push({ id: node.id, key, url, node });
    }
    await forEachBatch(candidates, visit);

    const { endCursor, hasNextPage } = data.requests.pageInfo;
    if (!hasNextPage) return false;
    // A malformed or cycling cursor must not loop forever or claim a complete sweep.
    if (
      data.requests.edges.length === 0 ||
      endCursor === undefined ||
      endCursor === "" ||
      endCursor === after ||
      visitedCursors.has(endCursor)
    ) {
      sdk.console.warn(
        "GraphX JS recon sweep stopped: pagination cursor did not advance; results are truncated.",
      );
      return true;
    }
    visitedCursors.add(endCursor);
    after = endCursor;
  }
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

const completed = Promise.resolve();

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

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

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
// `path` keeps the path and query for display; `url` includes scheme, host and
// port for identity, so captured variants cannot hide an unseen reference.
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
  return {
    path: `${resolved.pathname}${resolved.search}`,
    url: resolved.toString(),
  };
};

const buildHostJsRecon = async (
  sdk: BackendSDK,
  scopeId: string,
  host: string,
  active?: ActiveRun,
): Promise<JsReconFindings> => {
  const normalized = normalizeHostname(host);
  if (normalized === undefined) throw new Error(`Invalid host "${host}".`);

  const extractions: JsReconExtraction[] = [];
  const sourceMaps: string[] = [];
  const sourceMapsBlocked: string[] = [];
  const sourceMapsFetched: string[] = [];
  const sourceMapsInline: string[] = [];
  const sourceModules = new Set<string>();
  // sourceMappingURL leads discovered in scanned bundles: full request URL
  // (including scheme, port, and query) → display path plus query.
  const mapLeads = new Map<string, string>();
  let bundlesScanned = 0;
  let truncated = false;

  // Process one local page at a time; a malformed sweep cannot suppress the others.
  if (
    await sweepCandidates(
      sdk,
      scopeId,
      normalized,
      buildFilter(normalized, JS_PATH_CLAUSE, STATUS_OK),
      async (candidate) => {
        const text = await fetchBodyText(sdk, candidate.id);
        if (text === undefined) return;
        bundlesScanned += 1;
        extractions.push(
          extractJsRecon(text, {
            assetPath: candidate.key,
            requestId: candidate.id,
          }),
        );

        const ref = findSourceMapRef(text);
        if (ref === undefined) return;
        if (ref.startsWith("data:")) {
          // Inline map: no fetch needed, decode in place.
          const comma = ref.indexOf(",");
          if (comma >= 0 && ref.slice(0, comma).includes(";base64")) {
            const inline = Buffer.from(ref.slice(comma + 1), "base64").toString(
              "utf-8",
            );
            const recon = extractSourceMapRecon(inline, {
              assetPath: candidate.key,
              requestId: candidate.id,
            });
            if (recon !== undefined) {
              sourceMapsInline.push(candidate.key);
              for (const module of recon.sources) sourceModules.add(module);
              extractions.push(recon.extraction);
            }
          }
          return;
        }
        const lead = resolveMapUrl(ref, candidate.node, normalized);
        if (lead !== undefined) mapLeads.set(lead.url, lead.path);
      },
    )
  )
    truncated = true;

  const scannedUrls = new Set<string>();
  if (
    await sweepCandidates(
      sdk,
      scopeId,
      normalized,
      buildFilter(normalized, MAP_PATH_CLAUSE, STATUS_OK),
      async (candidate) => {
        const text = await fetchBodyText(sdk, candidate.id);
        if (text === undefined) return;
        const recon = extractSourceMapRecon(text, {
          assetPath: candidate.key,
          requestId: candidate.id,
        });
        if (recon === undefined) return;
        scannedUrls.add(candidate.url);
        sourceMaps.push(candidate.key);
        for (const module of recon.sources) sourceModules.add(module);
        extractions.push(recon.extraction);
      },
    )
  )
    truncated = true;

  // Maps that answered 4xx/5xx: they exist but their bodies are blocked —
  // prime candidates for manual bypass attempts.
  const blockedUrls = new Set<string>();
  if (
    await sweepCandidates(
      sdk,
      scopeId,
      normalized,
      buildFilter(normalized, MAP_PATH_CLAUSE, STATUS_BLOCKED),
      (candidate) => {
        const url = candidate.url;
        if (!scannedUrls.has(url) && !blockedUrls.has(url)) {
          blockedUrls.add(url);
          sourceMapsBlocked.push(candidate.key);
        }
        return completed;
      },
    )
  )
    truncated = true;

  // Count unresolved references even in passive scans, before active fetches
  // change the observed/blocked sets.
  let missingMapReferences = 0;
  for (const url of mapLeads.keys()) {
    if (!scannedUrls.has(url) && !blockedUrls.has(url)) {
      missingMapReferences += 1;
    }
  }

  // Only a UI-authorized active run may request an unseen source map.
  if (active !== undefined) {
    for (const [url, path] of mapLeads) {
      if (scannedUrls.has(url) || blockedUrls.has(url)) continue;
      if (
        active.options.maxRequests !== undefined &&
        active.summary.requestsSent >= active.options.maxRequests
      ) {
        active.summary.budgetExhausted = true;
        break;
      }
      const spec = new RequestSpec(url);
      const elapsed = Date.now() - (active.pacing.lastSendAt ?? -Infinity);
      const remaining = active.options.delayMs - elapsed;
      if (remaining > 0) await sleep(remaining);
      // Scope may change while sleeping; check immediately before the audit/send.
      if (!sdk.requests.inScope(spec, [scopeId])) {
        active.summary.skippedOutOfScope += 1;
        continue;
      }
      await active.audit({ type: "request", url });
      const project = await sdk.projects.getCurrent();
      if (project?.getId() !== active.projectId) {
        await active.audit({
          type: "failure",
          url,
          outcome: "Project changed before send.",
        });
        active.summary.failedRequests += 1;
        continue;
      }
      if (!sdk.requests.inScope(spec, [scopeId])) {
        await active.audit({
          type: "failure",
          url,
          outcome: "Scope changed before send.",
        });
        active.summary.skippedOutOfScope += 1;
        continue;
      }
      active.pacing.lastSendAt = Date.now();
      active.summary.requestsSent += 1;
      const sent = await sdk.requests.send(spec).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if ("error" in sent) {
        const message =
          sent.error instanceof Error ? sent.error.message : String(sent.error);
        await active.audit({ type: "failure", url, outcome: message });
        active.summary.failedRequests += 1;
        sdk.console.warn(`GraphX map fetch failed for ${url}: ${message}`);
        continue;
      }
      const code = sent.value.response?.getCode();
      const body = sent.value.response?.getBody();
      const blocked = code === undefined || code >= 400 || body === undefined;
      // A live fetch has no captured Caido request, even when a bundle led to it.
      const recon = blocked
        ? undefined
        : extractSourceMapRecon(body.toText(), { assetPath: path });
      await active.audit({
        type: "response",
        url,
        ...(code === undefined ? {} : { statusCode: code }),
        outcome: blocked
          ? "blocked"
          : recon === undefined
            ? "invalid-map"
            : "received",
      });
      if (recon === undefined) {
        active.summary.failedRequests += 1;
        if (blocked && !blockedUrls.has(url)) {
          blockedUrls.add(url);
          sourceMapsBlocked.push(path);
        }
        continue;
      }
      sourceMapsFetched.push(path);
      for (const module of recon.sources) sourceModules.add(module);
      extractions.push(recon.extraction);
    }
  }

  return {
    host: normalized,
    generatedAt: new Date().toISOString(),
    bundlesScanned,
    missingMapReferences,
    sourceMapsScanned: sourceMaps.length,
    sourceMaps: sourceMaps.sort(),
    sourceMapsBlocked: sourceMapsBlocked.sort(),
    sourceMapsFetched: sourceMapsFetched.sort(),
    sourceMapsInline: sourceMapsInline.sort(),
    sourceModules: [...sourceModules].sort(),
    truncated,
    ...(active === undefined ? {} : { activeRecon: active.summary }),
    ...mergeJsRecon(extractions),
  };
};

export type JsReconService = {
  scan: (
    host: string,
    scopeId?: string,
    options?: JsReconScanOptions,
  ) => Promise<Result<JsReconFindings>>;
  listAudit: (
    host: string,
    scopeId?: string,
  ) => Promise<Result<JsReconAuditEvent[]>>;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createJsReconService = (
  sdk: BackendSDK,
  repository: JsReconRepository,
): JsReconService => {
  // The plugin owns one send lane; spacing survives completed runs.
  let activeRunInProgress = false;
  const pacing: { lastSendAt?: number } = {};
  // Run IDs correlate audit events; they are not authorization tokens.
  let nextRunSequence = 0;
  return {
    scan: async (host, scopeId, options) => {
      const normalized = normalizeHostname(host);
      if (normalized === undefined) return err(`Invalid host "${host}".`);
      if (
        options !== undefined &&
        (typeof options !== "object" ||
          options === null ||
          Array.isArray(options))
      ) {
        return err("Invalid JS recon scan options.");
      }
      const activeOptions = options?.active;
      if (activeOptions !== undefined) {
        const validation = validateActiveReconOptions(activeOptions);
        if (validation !== undefined) return err(validation);
        if (activeRunInProgress)
          return err("An active JS recon run is already in progress.");
        activeRunInProgress = true;
      }

      try {
        const project = await sdk.projects.getCurrent();
        if (project === undefined)
          return err("No Caido project is currently selected.");
        const scope = await resolveScope(sdk, scopeId);
        if (activeOptions === undefined) {
          const findings = await buildHostJsRecon(sdk, scope.id, normalized);
          await repository.save(project.getId(), findings);
          return ok(findings);
        }

        nextRunSequence += 1;
        const summary: JsReconActiveSummary = {
          runId: `${Date.now().toString(36)}-${nextRunSequence.toString(36)}`,
          requestsSent: 0,
          requestBudget: activeOptions.maxRequests ?? "all",
          delayMs: activeOptions.delayMs,
          budgetExhausted: false,
          skippedOutOfScope: 0,
          failedRequests: 0,
        };
        const audit: ActiveRun["audit"] = (event) =>
          repository.appendAudit(project.getId(), {
            runId: summary.runId,
            time: new Date().toISOString(),
            scopeId: scope.id,
            host: normalized,
            requestBudget: summary.requestBudget,
            delayMs: summary.delayMs,
            ...event,
          });
        let started = false;
        try {
          await audit({ type: "start" });
          started = true;
          const findings = await buildHostJsRecon(sdk, scope.id, normalized, {
            projectId: project.getId(),
            options: activeOptions,
            summary,
            pacing,
            audit,
          });
          await repository.save(project.getId(), findings);
          await audit({ type: "finish", outcome: "completed" });
          return ok(findings);
        } catch (error: unknown) {
          if (started) {
            try {
              await audit({
                type: "finish",
                outcome: `failed: ${errorMessage(error)}`,
              });
            } catch {
              // An unavailable audit store must never permit another send.
            }
          }
          return err(errorMessage(error));
        }
      } catch (error: unknown) {
        return err(errorMessage(error));
      } finally {
        if (activeOptions !== undefined) activeRunInProgress = false;
      }
    },
    listAudit: async (host, scopeId) => {
      const normalized = normalizeHostname(host);
      if (normalized === undefined) return err(`Invalid host "${host}".`);
      try {
        const project = await sdk.projects.getCurrent();
        if (project === undefined)
          return err("No Caido project is currently selected.");
        const scope = await resolveScope(sdk, scopeId);
        return ok(
          await repository.listAudit(project.getId(), scope.id, normalized),
        );
      } catch (error: unknown) {
        return err(errorMessage(error));
      }
    },
  };
};
