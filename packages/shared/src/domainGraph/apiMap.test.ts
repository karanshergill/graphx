import { describe, expect, it } from "vitest";

import { type ApiMapRequest, buildApiMap, segmentParamKind } from "./apiMap";

const req = (
  path: string,
  overrides: Partial<ApiMapRequest> = {},
): ApiMapRequest => ({
  path,
  query: "",
  method: "GET",
  ...overrides,
});

describe("segmentParamKind", () => {
  it("classifies id-like segments", () => {
    expect(segmentParamKind("12345")).toBe("numeric");
    expect(segmentParamKind("8f3ac1a2-1111-4222-8333-abcdefabcdef")).toBe(
      "uuid",
    );
    expect(segmentParamKind("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("ulid");
    expect(segmentParamKind("2026-08-12")).toBe("date");
    expect(segmentParamKind("ab12cd34ef56gh78")).toBe("token");
  });

  it("leaves literal words alone", () => {
    expect(segmentParamKind("users")).toBeUndefined();
    expect(segmentParamKind("scores")).toBeUndefined();
    expect(segmentParamKind("authentication")).toBeUndefined();
    expect(segmentParamKind("v1")).toBeUndefined();
  });
});

describe("buildApiMap", () => {
  it("uses the sitemap as base truth: endpoints exist without any requests", () => {
    const routes = buildApiMap(["/api/users", "/api/health"], []);
    expect(routes.map((route) => route.template)).toEqual([
      "/api/health",
      "/api/users",
    ]);
    expect(routes[0]).toMatchObject({
      examplePath: "/api/health",
      inSitemap: true,
      requests: 0,
      statuses: {},
      methods: {},
    });
  });

  it("seeds examplePath from a real sitemap path, never the template", () => {
    const routes = buildApiMap(
      [
        "/users/8f3ac1a2-1111-4222-8333-abcdefabcdef/scores",
        "/users/91bc01a2-1111-4222-8333-abcdefabcdef/scores",
      ],
      [],
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.template).toBe("/users/{id}/scores");
    expect(routes[0]?.examplePath).toBe(
      "/users/8f3ac1a2-1111-4222-8333-abcdefabcdef/scores",
    );
  });

  it("collapses id segments from sitemap structure and joins request stats", () => {
    const routes = buildApiMap(
      [
        "/users/8f3ac1a2-1111-4222-8333-abcdefabcdef/scores",
        "/users/91bc01a2-1111-4222-8333-abcdefabcdef/scores",
      ],
      [
        req("/users/8f3ac1a2-1111-4222-8333-abcdefabcdef/scores", {
          statusCode: 200,
          seenAt: "2026-08-01T10:00:00Z",
        }),
        req("/users/91bc01a2-1111-4222-8333-abcdefabcdef/scores", {
          statusCode: 403,
          seenAt: "2026-08-02T10:00:00Z",
        }),
        req("/users/8f3ac1a2-1111-4222-8333-abcdefabcdef/scores", {
          method: "POST",
          statusCode: 409,
          query: "expand=full&limit=50",
        }),
      ],
    );
    expect(routes).toHaveLength(1);
    const route = routes[0];
    expect(route?.template).toBe("/users/{id}/scores");
    expect(route?.inSitemap).toBe(true);
    expect(route?.requests).toBe(3);
    expect(route?.methods).toEqual({ GET: 2, POST: 1 });
    expect(route?.statuses).toEqual({ "200": 1, "403": 1, "409": 1 });
    expect(route?.queryKeys).toEqual(["expand", "limit"]);
    expect(route?.firstSeen).toBe("2026-08-01T10:00:00Z");
    expect(route?.lastSeen).toBe("2026-08-02T10:00:00Z");
  });

  it("collapses by cardinality only above the threshold", () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => `/files/token-ab${n}cd`);
    expect(buildApiMap(many, [])[0]?.template).toBe("/files/{param}");
    const few = [1, 2, 3].map((n) => `/files/token-ab${n}cd`);
    expect(buildApiMap(few, [])).toHaveLength(3);
  });

  it("joins requests through literal matching when their path is not an id", () => {
    const sitemap = [1, 2, 3, 4, 5, 6].map((n) => `/users/user-${n}/scores`);
    const routes = buildApiMap(sitemap, [
      req("/users/someuser/scores", { statusCode: 200 }),
    ]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.template).toBe("/users/{param}/scores");
    expect(routes[0]?.requests).toBe(1);
  });

  it("marks requests with no sitemap endpoint as inSitemap: false", () => {
    const routes = buildApiMap(
      ["/api/known"],
      [req("/api/phantom", { statusCode: 404 })],
    );
    expect(routes).toHaveLength(2);
    const phantom = routes.find((route) => route.template === "/api/phantom");
    expect(phantom).toMatchObject({
      inSitemap: false,
      requests: 1,
      statuses: { "404": 1 },
    });
  });

  it("does not collapse varying literals in different surroundings", () => {
    const routes = buildApiMap(
      ["/alpha/red", "/alpha/green", "/beta/red", "/beta/blue"],
      [],
    );
    expect(routes.map((route) => route.template)).toEqual([
      "/alpha/green",
      "/alpha/red",
      "/beta/blue",
      "/beta/red",
    ]);
  });

  it("is deterministic regardless of input order", () => {
    const a = buildApiMap(
      ["/b/9", "/a/1", "/a/2"],
      [req("/a/2"), req("/b/9"), req("/a/1")],
    );
    const b = buildApiMap(
      ["/a/2", "/b/9", "/a/1"],
      [req("/a/1"), req("/a/2"), req("/b/9")],
    );
    expect(a).toEqual(b);
  });
});
