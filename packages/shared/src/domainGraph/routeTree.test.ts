import { describe, expect, it } from "vitest";

import type { ApiRoute } from "./apiMap";
import {
  buildRouteTree,
  countRouteTreeEndpoints,
  layoutRouteTree,
} from "./routeTree";

const route = (template: string, requests = 1): ApiRoute => ({
  template,
  examplePath: template,
  inSitemap: true,
  requests,
  methods: { GET: requests },
  statuses: { "200": requests },
  queryKeys: [],
});

describe("buildRouteTree", () => {
  it("builds a segment trie with endpoints at the right depth", () => {
    const root = buildRouteTree([
      route("/api/users/{id}/scores", 41),
      route("/api/users/{id}/profile", 9),
      route("/api/health", 3),
    ]);
    expect(root.children.map((node) => node.segment)).toEqual(["api"]);
    const api = root.children[0];
    expect(api?.children.map((node) => node.segment).sort()).toEqual([
      "health",
      "users",
    ]);
    const users = api?.children.find((node) => node.segment === "users");
    const id = users?.children[0];
    expect(id?.segment).toBe("{id}");
    expect(id?.children.map((node) => node.segment)).toEqual([
      "profile",
      "scores",
    ]);
    const scores = id?.children.find((node) => node.segment === "scores");
    expect(scores?.endpoint?.requests).toBe(41);
    expect(api?.endpoint).toBeUndefined();
  });

  it("keeps {id} and {param} as distinct param kinds but unifies same-kind params", () => {
    const root = buildRouteTree([
      route("/a/{id}/x"),
      route("/a/{param}/y"),
      route("/a/{id}/z"),
    ]);
    const a = root.children[0];
    expect(a?.children.map((node) => node.segment)).toEqual([
      "{id}",
      "{param}",
    ]);
    const id = a?.children.find((node) => node.segment === "{id}");
    expect(id?.children.map((node) => node.segment)).toEqual(["x", "z"]);
    expect(countRouteTreeEndpoints(root)).toBe(3);
  });

  it("sorts literals before params, alphabetically", () => {
    const root = buildRouteTree([
      route("/x/{param}"),
      route("/x/zeta"),
      route("/x/alpha"),
    ]);
    const x = root.children[0];
    expect(x?.children.map((node) => node.segment)).toEqual([
      "alpha",
      "zeta",
      "{param}",
    ]);
  });
});

describe("layoutRouteTree", () => {
  it("is deterministic, depths as x, leaves get unique y", () => {
    const root = buildRouteTree([
      route("/api/users/{id}/scores"),
      route("/api/users/{id}/profile"),
      route("/api/health"),
      route("/api/status/live"),
    ]);
    const first = layoutRouteTree(root);
    const second = layoutRouteTree(root);
    expect(first).toEqual(second);

    const leafYs: number[] = [];
    const collectLeafYs = (node: typeof root): void => {
      if (node.children.length === 0) {
        const position = first.get(node.id);
        if (position !== undefined) leafYs.push(position.y);
        return;
      }
      for (const child of node.children) collectLeafYs(child);
    };
    collectLeafYs(root);
    expect(new Set(leafYs).size).toBe(leafYs.length);

    for (const [id, position] of first) {
      const depth = id
        .split("/")
        .filter((segment) => segment.length > 0).length;
      expect(position.x).toBe(depth);
    }
    const allYs = [...first.values()].map((position) => position.y);
    const rootY = first.get("/")?.y;
    expect(rootY).toBeGreaterThanOrEqual(Math.min(...allYs));
    expect(rootY).toBeLessThanOrEqual(Math.max(...allYs));
  });
});
