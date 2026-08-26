import { Buffer } from "buffer";

import {
  err,
  extractJsRecon,
  extractSourceMapRecon,
  type JsReconExtraction,
  type JsReconFindings,
  mergeJsRecon,
  normalizeHostname,
  ok,
  type Result,
} from "shared";

import { execute, resolveScope } from "../agentapi/query";
import type { JsReconRepository } from "../repositories";
import type { BackendSDK } from "../types";

const PAGE_SIZE = 200;

type JsRequestPage = {
  requests: {
    edges: { cursor: string; node: { id: string; path: string } }[];
    pageInfo: { endCursor?: string; hasNextPage: boolean };
  };
};

type JsRequestBody = {
  request?: { response?: { raw?: string } };
};

type Candidate = { id: string; path: string };

// LIKE without wildcards is ASCII case-insensitive; the second clause also
// matches Host headers carrying an explicit port.
const buildFilter = (host: string, pathClause: string): string =>
  `(req.host.like:"${host}" or req.host.like:"${host}:%") ` +
  `and ${pathClause} and resp.code.lt:400`;

const JS_PATH_CLAUSE = '(req.path.like:"%.js" or req.path.like:"%.mjs")';
const MAP_PATH_CLAUSE = '(req.path.like:"%.map")';

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
  const seenPaths = new Set<string>();
  const candidates: Candidate[] = [];
  let truncated = false;
  let after: string | undefined;

  for (;;) {
    const data = await execute<JsRequestPage>(
      sdk,
      "query($scopeId: ID, $filter: HTTPQLInput, $first: Int, $after: String, $order: RequestResponseOrderInput) { requests(scopeId: $scopeId, filter: $filter, first: $first, after: $after, order: $order) { edges { cursor node { id path } } pageInfo { endCursor hasNextPage } } }",
      {
        scopeId,
        filter: { code: filter },
        first: PAGE_SIZE,
        order: { by: "CREATED_AT", ordering: "DESC" },
        ...(after === undefined ? {} : { after }),
      },
    );

    for (const edge of data.requests.edges) {
      const { id, path } = edge.node;
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      candidates.push({ id, path });
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
  const data = await execute<JsRequestBody>(
    sdk,
    "query($id: ID!) { request(id: $id) { response { raw } } }",
    { id },
  );
  const raw = data.request?.response?.raw;
  if (typeof raw !== "string") return undefined;
  return decodeBody(raw);
};

const buildHostJsRecon = async (
  sdk: BackendSDK,
  scopeId: string,
  host: string,
): Promise<JsReconFindings> => {
  const normalized = normalizeHostname(host);
  if (normalized === undefined) throw new Error(`Invalid host "${host}".`);

  const extractions: JsReconExtraction[] = [];
  const sourceMaps: string[] = [];
  const sourceModules = new Set<string>();
  let bundlesScanned = 0;
  let truncated = false;

  const jsCandidates = await collectCandidates(
    sdk,
    scopeId,
    buildFilter(normalized, JS_PATH_CLAUSE),
  );
  truncated ||= jsCandidates.truncated;

  for (const candidate of jsCandidates.candidates) {
    const text = await fetchBodyText(sdk, candidate.id);
    if (text === undefined) continue;
    bundlesScanned += 1;
    extractions.push(extractJsRecon(text));
  }

  const mapCandidates = await collectCandidates(
    sdk,
    scopeId,
    buildFilter(normalized, MAP_PATH_CLAUSE),
  );
  truncated ||= mapCandidates.truncated;

  for (const candidate of mapCandidates.candidates) {
    const text = await fetchBodyText(sdk, candidate.id);
    if (text === undefined) continue;
    const recon = extractSourceMapRecon(text);
    if (recon === undefined) continue;
    sourceMaps.push(candidate.path);
    for (const module of recon.sources) sourceModules.add(module);
    extractions.push(recon.extraction);
  }

  return {
    host: normalized,
    generatedAt: new Date().toISOString(),
    bundlesScanned,
    sourceMapsScanned: sourceMaps.length,
    sourceMaps: sourceMaps.sort(),
    sourceModules: [...sourceModules].sort(),
    truncated,
    ...mergeJsRecon(extractions),
  };
};

export type JsReconService = {
  scan: (host: string, scopeId?: string) => Promise<Result<JsReconFindings>>;
};

export const createJsReconService = (
  sdk: BackendSDK,
  repository: JsReconRepository,
): JsReconService => ({
  scan: async (host, scopeId) => {
    try {
      if (normalizeHostname(host) === undefined)
        return err(`Invalid host "${host}".`);
      const project = await sdk.projects.getCurrent();
      if (project === undefined)
        return err("No Caido project is currently selected.");
      const scope = await resolveScope(sdk, scopeId);
      const findings = await buildHostJsRecon(sdk, scope.id, host);
      await repository.save(project.getId(), findings);
      return ok(findings);
    } catch (error: unknown) {
      return err(error instanceof Error ? error.message : String(error));
    }
  },
});
