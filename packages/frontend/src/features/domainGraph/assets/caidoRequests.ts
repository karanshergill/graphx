import {
  classifyAssetPath,
  isJavaScriptResponse,
  JS_ASSETS_HTTPQL,
  normalizeSeenAt,
  type ObservedAssetRequest,
} from "shared";

import type { FrontendSDK } from "@/types";

const PAGE_SIZE = 500;
const MAX_SWEEP_REQUESTS = 100_000;
const RAW_FETCH_CONCURRENCY = 16;

type AssetEdge = {
  node: {
    host: string;
    path: string;
    query: string;
    isTls: boolean;
    port: number;
    createdAt: unknown;
  };
};

const readAssetEdge = async (
  sdk: FrontendSDK,
  edge: AssetEdge,
  response: { id: string; statusCode: number } | undefined,
): Promise<ObservedAssetRequest | undefined> => {
  const { node } = edge;
  const suffixAsset = classifyAssetPath(node.path) !== undefined;
  if (!suffixAsset) {
    const responseId = response?.id;
    if (responseId === undefined) return undefined;
    try {
      const result = await sdk.graphql.response({ id: responseId });
      const raw = result.response?.raw;
      // The frontend SDK has already decoded response.raw to HTTP text.
      if (typeof raw !== "string" || !isJavaScriptResponse(raw))
        return undefined;
    } catch {
      // Unreadable captured responses must not interrupt the rest of the sweep.
      return undefined;
    }
  }
  const request: ObservedAssetRequest = {
    host: node.host,
    path: node.path,
    query: node.query,
    isTls: node.isTls,
    port: node.port,
  };
  if (!suffixAsset) request.isJavaScript = true;
  const statusCode = response?.statusCode;
  if (statusCode !== undefined && statusCode !== null)
    request.statusCode = statusCode;
  const seenAt = normalizeSeenAt(node.createdAt);
  if (seenAt !== undefined) request.seenAt = seenAt;
  return request;
};

type JsAssetSweep = {
  requests: ObservedAssetRequest[];
  truncated: boolean;
};

export const readJsAssetRequestsSnapshot = async (
  sdk: FrontendSDK,
  scopeId: string,
): Promise<number> => {
  const result = await sdk.graphql.requestCount({
    scopeId,
    filter: { code: JS_ASSETS_HTTPQL },
  });
  return result.requests.snapshot;
};

export const readJsAssetRequests = async (
  sdk: FrontendSDK,
  scopeId: string,
): Promise<JsAssetSweep> => {
  const requests: ObservedAssetRequest[] = [];
  let scannedRequests = 0;
  let after: string | undefined;

  for (;;) {
    const result = await sdk.graphql.requests({
      scopeId,
      filter: { code: JS_ASSETS_HTTPQL },
      first: PAGE_SIZE,
      order: { by: "CREATED_AT", ordering: "DESC" },
      ...(after === undefined ? {} : { after }),
    });
    const edges = result.requests.edges;
    scannedRequests += edges.length;
    for (let start = 0; start < edges.length; start += RAW_FETCH_CONCURRENCY) {
      const batch = await Promise.all(
        edges
          .slice(start, start + RAW_FETCH_CONCURRENCY)
          .map((edge) =>
            readAssetEdge(sdk, edge, edge.node.response ?? undefined),
          ),
      );
      for (const request of batch) {
        if (request !== undefined) requests.push(request);
      }
    }
    const { endCursor, hasNextPage } = result.requests.pageInfo;
    if (!hasNextPage || endCursor === undefined || endCursor === null) {
      return { requests, truncated: false };
    }
    if (scannedRequests >= MAX_SWEEP_REQUESTS) {
      sdk.log.warn(
        "GraphX JS asset sweep stopped: request budget exhausted; asset lists are truncated.",
      );
      return { requests, truncated: true };
    }
    if (endCursor === after) {
      sdk.log.warn(
        "GraphX JS asset sweep stopped: pagination cursor did not advance; asset lists are truncated.",
      );
      return { requests, truncated: true };
    }
    after = endCursor;
  }
};
