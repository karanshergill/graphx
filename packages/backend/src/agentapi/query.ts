import {
  type ApiMapRequest,
  type ApiMapResponse,
  buildApiMap,
  buildDomainGraph,
  type DomainGraphSnapshot,
  groupAssetsByHost,
  type HostAssets,
  JS_ASSETS_HTTPQL,
  normalizeHostname,
  normalizeSeenAt,
  type ObservedAssetRequest,
  type ScopeDefinition,
  type SitemapDomainEntry,
} from "shared";

import type { BackendSDK } from "../types";

type GraphqlData<T> = {
  data?: T;
  errors?: { message: string }[];
};

export const execute = async <T>(
  sdk: BackendSDK,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const response = (await sdk.graphql.execute(
    query,
    variables ?? {},
  )) as GraphqlData<T>;
  if (response.errors !== undefined && response.errors.length > 0) {
    throw new Error(response.errors.map((error) => error.message).join("; "));
  }
  if (response.data === undefined) throw new Error("Empty GraphQL response.");
  return response.data;
};

const readScopes = async (sdk: BackendSDK): Promise<ScopeDefinition[]> => {
  const data = await execute<{ scopes: ScopeDefinition[] }>(
    sdk,
    "query { scopes { id name allowlist denylist } }",
  );
  return data.scopes;
};

export const resolveScope = async (
  sdk: BackendSDK,
  scopeParam: string | undefined,
): Promise<ScopeDefinition> => {
  const scopes = await readScopes(sdk);
  if (scopeParam === undefined || scopeParam.trim().length === 0) {
    if (scopes.length === 1 && scopes[0] !== undefined) return scopes[0];
    throw new Error(
      `Pass ?scope= with one of: ${scopes.map((scope) => `${scope.name} (${scope.id})`).join(", ")}`,
    );
  }
  const needle = scopeParam.trim().toLowerCase();
  const match = scopes.find(
    (scope) =>
      scope.id.toLowerCase() === needle || scope.name.toLowerCase() === needle,
  );
  if (match === undefined) {
    throw new Error(
      `Unknown scope "${scopeParam}". Available: ${scopes.map((scope) => `${scope.name} (${scope.id})`).join(", ")}`,
    );
  }
  return match;
};

export const readSitemapDomains = async (
  sdk: BackendSDK,
  scopeId: string,
): Promise<SitemapDomainEntry[]> => {
  const data = await execute<{
    sitemapRootEntries: {
      edges: { node: SitemapDomainEntry & { kind: string } }[];
    };
  }>(
    sdk,
    "query($scopeId: ID) { sitemapRootEntries(scopeId: $scopeId) { edges { node { id label kind } } } }",
    { scopeId },
  );
  return data.sitemapRootEntries.edges
    .filter((edge) => edge.node.kind === "DOMAIN")
    .map((edge) => ({ id: edge.node.id, label: edge.node.label }));
};

export const buildScopeDomainGraph = (
  scope: ScopeDefinition,
  entries: SitemapDomainEntry[],
): DomainGraphSnapshot =>
  buildDomainGraph({
    scope,
    entries,
    generatedAt: new Date().toISOString(),
  });

const PAGE_SIZE = 500;
const MAX_SWEEP_REQUESTS = 100_000;

type JsAssetSweep = {
  requests: ObservedAssetRequest[];
  truncated: boolean;
};

type RequestsPage = {
  requests: {
    edges: {
      cursor: string;
      node: {
        host: string;
        path: string;
        createdAt: unknown;
        response?: { statusCode: number };
      };
    }[];
    pageInfo: { endCursor?: string; hasNextPage: boolean };
  };
};

export const readJsAssetRequests = async (
  sdk: BackendSDK,
  scopeId: string,
): Promise<JsAssetSweep> => {
  const requests: ObservedAssetRequest[] = [];
  let after: string | undefined;

  for (;;) {
    const data = await execute<RequestsPage>(
      sdk,
      "query($scopeId: ID, $filter: HTTPQLInput, $first: Int, $after: String, $order: RequestResponseOrderInput) { requests(scopeId: $scopeId, filter: $filter, first: $first, after: $after, order: $order) { edges { cursor node { host path createdAt response { statusCode } } } pageInfo { endCursor hasNextPage } } }",
      {
        scopeId,
        filter: { code: JS_ASSETS_HTTPQL },
        first: PAGE_SIZE,
        order: { by: "CREATED_AT", ordering: "DESC" },
        ...(after === undefined ? {} : { after }),
      },
    );
    for (const edge of data.requests.edges) {
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
    const { endCursor, hasNextPage } = data.requests.pageInfo;
    if (!hasNextPage || endCursor === undefined) {
      return { requests, truncated: false };
    }
    if (requests.length >= MAX_SWEEP_REQUESTS) {
      sdk.console.warn(
        "GraphX sweep stopped: request budget exhausted; results are truncated.",
      );
      return { requests, truncated: true };
    }
    if (endCursor === after) {
      sdk.console.warn(
        "GraphX JS asset sweep stopped: pagination cursor did not advance; asset lists are truncated.",
      );
      return { requests, truncated: true };
    }
    after = endCursor;
  }
};

const readSitemapHostPaths = async (
  sdk: BackendSDK,
  scopeId: string,
  host: string,
): Promise<string[]> => {
  const normalized = normalizeHostname(host);
  if (normalized === undefined) throw new Error(`Invalid host "${host}".`);

  const roots = await execute<{
    sitemapRootEntries: {
      edges: { node: { id: string; label: string; kind: string } }[];
    };
  }>(
    sdk,
    "query($scopeId: ID) { sitemapRootEntries(scopeId: $scopeId) { edges { node { id label kind } } } }",
    { scopeId },
  );
  const rootIds = roots.sitemapRootEntries.edges
    .filter(
      (edge) =>
        edge.node.kind === "DOMAIN" &&
        normalizeHostname(edge.node.label) === normalized,
    )
    .map((edge) => edge.node.id);
  if (rootIds.length === 0) {
    throw new Error(`Host "${normalized}" is not present in the sitemap.`);
  }

  const paths = new Set<string>();
  for (const rootId of rootIds) {
    const data = await execute<{
      sitemapDescendantEntries: {
        edges: {
          node: {
            id: string;
            label: string;
            kind: string;
            parentId?: string;
          };
        }[];
      };
    }>(
      sdk,
      "query($id: ID) { sitemapDescendantEntries(parentId: $id, depth: ALL) { edges { node { id label kind parentId } } } }",
      { id: rootId },
    );
    const byId = new Map(
      data.sitemapDescendantEntries.edges.map((edge) => [
        edge.node.id,
        edge.node,
      ]),
    );
    const pathFor = (id: string): string | undefined => {
      const segments: string[] = [];
      const visited = new Set<string>();
      let current = byId.get(id);
      while (current !== undefined && !visited.has(current.id)) {
        visited.add(current.id);
        segments.unshift(current.label);
        if (current.parentId === undefined || current.parentId === rootId)
          break;
        current = byId.get(current.parentId);
      }
      return segments.length === 0 ? undefined : `/${segments.join("/")}`;
    };
    for (const edge of data.sitemapDescendantEntries.edges) {
      if (edge.node.kind !== "REQUEST") continue;
      const path = pathFor(edge.node.id);
      if (path !== undefined) paths.add(path);
    }
  }
  return [...paths].sort();
};

export const groupJsAssets = (
  requests: ObservedAssetRequest[],
): Map<string, HostAssets> => groupAssetsByHost(requests);

type HostRequestsPage = {
  requests: {
    edges: {
      node: {
        path: string;
        query: string;
        method: string;
        createdAt: unknown;
        response?: { statusCode: number };
      };
    }[];
    pageInfo: { endCursor?: string; hasNextPage: boolean };
  };
};

export const buildHostApiMap = async (
  sdk: BackendSDK,
  scopeId: string,
  host: string,
): Promise<ApiMapResponse> => {
  const sitemapPaths = await readSitemapHostPaths(sdk, scopeId, host);
  const sweep = await readHostRequests(sdk, scopeId, host);
  const routes = buildApiMap(sitemapPaths, sweep.requests);
  return {
    sitemapEndpoints: sitemapPaths.length,
    requestsScanned: sweep.requests.length,
    truncated: sweep.truncated,
    routeCount: routes.length,
    routes,
  };
};

type HostRequestSweep = {
  requests: ApiMapRequest[];
  truncated: boolean;
};

const readHostRequests = async (
  sdk: BackendSDK,
  scopeId: string,
  host: string,
): Promise<HostRequestSweep> => {
  const normalized = normalizeHostname(host);
  if (normalized === undefined) throw new Error(`Invalid host "${host}".`);

  const requests: ApiMapRequest[] = [];
  let after: string | undefined;

  for (;;) {
    const data = await execute<HostRequestsPage>(
      sdk,
      "query($scopeId: ID, $filter: HTTPQLInput, $first: Int, $after: String, $order: RequestResponseOrderInput) { requests(scopeId: $scopeId, filter: $filter, first: $first, after: $after, order: $order) { edges { node { path query method createdAt response { statusCode } } } pageInfo { endCursor hasNextPage } } }",
      {
        scopeId,
        filter: {
          // HTTPQL eq is case-sensitive and matches the raw Host header, so
          // eq would miss `Example.COM` and `example.com:8080`. LIKE without
          // wildcards is ASCII case-insensitive; the second clause also
          // matches Host headers carrying an explicit port.
          code: `(req.host.like:"${normalized}" or req.host.like:"${normalized}:%")`,
        },
        first: PAGE_SIZE,
        order: { by: "CREATED_AT", ordering: "DESC" },
        ...(after === undefined ? {} : { after }),
      },
    );
    for (const edge of data.requests.edges) {
      const request: ApiMapRequest = {
        path: edge.node.path,
        query: edge.node.query,
        method: edge.node.method,
      };
      const statusCode = edge.node.response?.statusCode;
      if (statusCode !== undefined && statusCode !== null)
        request.statusCode = statusCode;
      const seenAt = normalizeSeenAt(edge.node.createdAt);
      if (seenAt !== undefined) request.seenAt = seenAt;
      requests.push(request);
    }
    const { endCursor, hasNextPage } = data.requests.pageInfo;
    if (!hasNextPage || endCursor === undefined) {
      return { requests, truncated: false };
    }
    if (requests.length >= MAX_SWEEP_REQUESTS) {
      sdk.console.warn(
        "GraphX sweep stopped: request budget exhausted; results are truncated.",
      );
      return { requests, truncated: true };
    }
    if (endCursor === after) {
      sdk.console.warn(
        "GraphX host request sweep stopped: pagination cursor did not advance; results are truncated.",
      );
      return { requests, truncated: true };
    }
    after = endCursor;
  }
};
