import { Buffer } from "buffer";

import {
  err,
  extractJsRecon,
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
const MAX_BUNDLES = 100;
const MAX_BODY_LENGTH = 8_000_000;
const MAX_TOTAL_LENGTH = 32_000_000;

type JsRequestPage = {
  requests: {
    edges: { cursor: string; node: { id: string; path: string } }[];
    pageInfo: { endCursor?: string; hasNextPage: boolean };
  };
};

type JsRequestBody = {
  request?: { response?: { raw?: string } };
};

// LIKE without wildcards is ASCII case-insensitive; the second clause also
// matches Host headers carrying an explicit port.
const buildFilter = (host: string): string =>
  `(req.host.like:"${host}" or req.host.like:"${host}:%") ` +
  'and (req.path.like:"%.js" or req.path.like:"%.mjs") and resp.code.lt:400';

// `raw` is the base64-encoded raw HTTP response (status line, headers, body).
const decodeBody = (raw: string): string | undefined => {
  const text = Buffer.from(raw, "base64").toString("utf-8");
  const separator = text.indexOf("\r\n\r\n");
  if (separator === -1) return undefined;
  return text.slice(separator + 4);
};

const buildHostJsRecon = async (
  sdk: BackendSDK,
  scopeId: string,
  host: string,
): Promise<JsReconFindings> => {
  const normalized = normalizeHostname(host);
  if (normalized === undefined) throw new Error(`Invalid host "${host}".`);

  const seenPaths = new Set<string>();
  const extractions: JsReconExtraction[] = [];
  let totalLength = 0;
  let truncated = false;
  let after: string | undefined;

  for (;;) {
    const data = await execute<JsRequestPage>(
      sdk,
      "query($scopeId: ID, $filter: HTTPQLInput, $first: Int, $after: String, $order: RequestResponseOrderInput) { requests(scopeId: $scopeId, filter: $filter, first: $first, after: $after, order: $order) { edges { cursor node { id path } } pageInfo { endCursor hasNextPage } } }",
      {
        scopeId,
        filter: { code: buildFilter(normalized) },
        first: PAGE_SIZE,
        order: { by: "CREATED_AT", ordering: "DESC" },
        ...(after === undefined ? {} : { after }),
      },
    );

    for (const edge of data.requests.edges) {
      const { id, path } = edge.node;
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      if (
        extractions.length >= MAX_BUNDLES ||
        totalLength >= MAX_TOTAL_LENGTH
      ) {
        truncated = true;
        break;
      }
      const bodyData = await execute<JsRequestBody>(
        sdk,
        "query($id: ID!) { request(id: $id) { response { raw } } }",
        { id },
      );
      const raw = bodyData.request?.response?.raw;
      if (typeof raw !== "string") continue;
      const text = decodeBody(raw);
      if (text === undefined) continue;
      if (text.length > MAX_BODY_LENGTH) {
        truncated = true;
        continue;
      }
      totalLength += text.length;
      extractions.push(extractJsRecon(text));
    }
    if (truncated) break;

    const { endCursor, hasNextPage } = data.requests.pageInfo;
    if (!hasNextPage || endCursor === undefined) break;
    if (endCursor === after) {
      sdk.console.warn(
        "GraphX JS recon sweep stopped: pagination cursor did not advance; results are truncated.",
      );
      truncated = true;
      break;
    }
    after = endCursor;
  }

  return {
    host: normalized,
    generatedAt: new Date().toISOString(),
    bundlesScanned: extractions.length,
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
