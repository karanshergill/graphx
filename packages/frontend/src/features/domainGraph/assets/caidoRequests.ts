import {
  JS_ASSETS_HTTPQL,
  normalizeSeenAt,
  type ObservedAssetRequest,
} from "shared";

import type { FrontendSDK } from "@/types";

const PAGE_SIZE = 500;

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
  let after: string | undefined;

  for (;;) {
    const result = await sdk.graphql.requests({
      scopeId,
      filter: { code: JS_ASSETS_HTTPQL },
      first: PAGE_SIZE,
      order: { by: "CREATED_AT", ordering: "DESC" },
      ...(after === undefined ? {} : { after }),
    });
    for (const edge of result.requests.edges) {
      const request: ObservedAssetRequest = {
        host: edge.node.host,
        path: edge.node.path,
      };
      const statusCode = edge.node.response?.statusCode;
      if (statusCode !== undefined && statusCode !== null)
        request.statusCode = statusCode;
      const seenAt = normalizeSeenAt(edge.node.createdAt);
      if (seenAt !== undefined) request.seenAt = seenAt;
      requests.push(request);
    }
    const { endCursor, hasNextPage } = result.requests.pageInfo;
    if (!hasNextPage || endCursor === undefined || endCursor === null) {
      return { requests, truncated: false };
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
