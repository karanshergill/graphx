import type { ApiMapResponse, ScopeDefinition } from "shared";
import { normalizeHostname } from "shared";

import type { DomainMarksService, JsReconService } from "../services";
import type { BackendSDK } from "../types";

import {
  buildHostApiMap,
  buildScopeDomainGraph,
  groupJsAssets,
  readJsAssetRequests,
  readSitemapDomains,
  resolveScope,
} from "./query";
import type { AgentRoute } from "./server";

type RouteResult = { status: number; body: unknown };

const VERSION = "0.3.0";

const ok = (body: unknown): RouteResult => ({ status: 200, body });
const badRequest = (message: string): RouteResult => ({
  status: 400,
  body: { error: message },
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createAgentRoutes = (
  sdk: BackendSDK,
  marksService: DomainMarksService,
  jsReconService: JsReconService,
): AgentRoute[] => {
  const currentProject = async (): Promise<
    { id: string; name: string } | undefined
  > => {
    const project = await sdk.projects.getCurrent();
    if (project === undefined) return undefined;
    return { id: project.getId(), name: project.getName() };
  };

  const withScope = async (
    query: URLSearchParams,
    run: (scope: ScopeDefinition) => Promise<RouteResult>,
  ): Promise<RouteResult> => {
    let scope: ScopeDefinition;
    try {
      scope = await resolveScope(sdk, query.get("scope") ?? undefined);
    } catch (error: unknown) {
      return badRequest(errorMessage(error));
    }
    return run(scope);
  };

  return [
    {
      method: "GET",
      path: "/health",
      handle: () => Promise.resolve(ok({ ok: true, version: VERSION })),
    },
    {
      method: "GET",
      path: "/marks",
      handle: async () => {
        const result = await marksService.list();
        if (result.kind === "Error") return badRequest(result.error);
        return ok({ project: await currentProject(), marks: result.value });
      },
    },
    {
      method: "GET",
      path: "/domains",
      handle: (query) =>
        withScope(query, async (scope) => {
          const entries = await readSitemapDomains(sdk, scope.id);
          return ok({
            project: await currentProject(),
            graph: buildScopeDomainGraph(scope, entries),
          });
        }),
    },
    {
      method: "GET",
      path: "/assets",
      handle: (query) =>
        withScope(query, async (scope) => {
          const sweep = await readJsAssetRequests(sdk, scope.id);
          const grouped = groupJsAssets(sweep.requests);
          const hosts: Record<string, unknown> = {};
          for (const [host, assets] of grouped) hosts[host] = assets;
          return ok({
            project: await currentProject(),
            requestsScanned: sweep.requests.length,
            truncated: sweep.truncated,
            hostsWithJs: grouped.size,
            hosts,
          });
        }),
    },
    {
      method: "GET",
      path: "/brief",
      handle: (query) =>
        withScope(query, async (scope) => {
          const entries = await readSitemapDomains(sdk, scope.id);
          const graph = buildScopeDomainGraph(scope, entries);
          const sweep = await readJsAssetRequests(sdk, scope.id);
          const grouped = groupJsAssets(sweep.requests);
          const marks = await marksService.list();
          return ok({
            project: await currentProject(),
            scope: { id: scope.id, name: scope.name },
            generatedAt: graph.generatedAt,
            truncated: sweep.truncated,
            domains: {
              stats: graph.stats,
              hosts: graph.nodes.map((node) => {
                const assets = grouped.get(node.hostname);
                return {
                  hostname: node.hostname,
                  depth: node.depth,
                  observed: node.observed,
                  marked:
                    marks.kind === "Ok" && marks.value.includes(node.hostname),
                  js: assets?.bundleCount ?? 0,
                  maps: assets?.mapCount ?? 0,
                  ...(assets?.lastSeen !== undefined
                    ? { lastSeen: assets.lastSeen }
                    : {}),
                };
              }),
            },
            marks: marks.kind === "Ok" ? marks.value : [],
          });
        }),
    },
    {
      method: "GET",
      path: "/api-map",
      handle: (query) =>
        withScope(query, async (scope) => {
          const host = query.get("host") ?? undefined;
          if (host === undefined || host.trim().length === 0) {
            return badRequest("Pass ?host=<hostname> to map.");
          }
          if (normalizeHostname(host) === undefined) {
            return badRequest(`Invalid host "${host}".`);
          }
          let map: ApiMapResponse;
          try {
            map = await buildHostApiMap(sdk, scope.id, host);
          } catch (error: unknown) {
            return badRequest(errorMessage(error));
          }
          return ok({
            project: await currentProject(),
            scope: { id: scope.id, name: scope.name },
            host,
            generatedAt: new Date().toISOString(),
            ...map,
          });
        }),
    },
    {
      method: "GET",
      path: "/js-recon",
      handle: (query) =>
        withScope(query, async (scope) => {
          const host = query.get("host") ?? undefined;
          if (host === undefined || host.trim().length === 0) {
            return badRequest("Pass ?host=<hostname> to scan.");
          }
          if (normalizeHostname(host) === undefined) {
            return badRequest(`Invalid host "${host}".`);
          }
          const result = await jsReconService.scan(host, scope.id);
          if (result.kind === "Error") return badRequest(result.error);
          return ok({
            project: await currentProject(),
            scope: { id: scope.id, name: scope.name },
            ...result.value,
          });
        }),
    },
  ];
};
