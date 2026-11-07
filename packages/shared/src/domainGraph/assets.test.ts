import { describe, expect, it } from "vitest";

import {
  classifyAssetPath,
  groupAssetsByHost,
  isJavaScriptResponse,
  normalizeSeenAt,
  type ObservedAssetRequest,
} from "./assets";

describe("classifyAssetPath", () => {
  it("classifies bundles and maps, with .js.map as a map", () => {
    expect(classifyAssetPath("/assets/main.js")).toBe("bundle");
    expect(classifyAssetPath("/assets/main.mjs")).toBe("bundle");
    expect(classifyAssetPath("/assets/main.js.map")).toBe("map");
    expect(classifyAssetPath("/assets/main.map")).toBe("map");
  });

  it("rejects non-JS paths and .json lookalikes", () => {
    expect(classifyAssetPath("/api/data.json")).toBeUndefined();
    expect(classifyAssetPath("/app.jsx")).toBeUndefined();
    expect(classifyAssetPath("/index.html")).toBeUndefined();
  });

  it("is case-insensitive and ignores query strings", () => {
    expect(classifyAssetPath("/APP/MAIN.JS?v=3")).toBe("bundle");
    expect(classifyAssetPath("/APP/MAIN.JS.MAP")).toBe("map");
  });

  it("classifies a MIME-confirmed extensionless script but never a map as a bundle", () => {
    expect(classifyAssetPath("/assets/entry?build=2", true)).toBe("bundle");
    expect(classifyAssetPath("/assets/entry.map", true)).toBe("map");
    expect(classifyAssetPath("/assets/decoy", false)).toBeUndefined();
  });
});

describe("isJavaScriptResponse", () => {
  it("accepts JavaScript MIME in case-insensitive response headers with parameters", () => {
    expect(
      isJavaScriptResponse(
        "HTTP/1.1 200 OK\r\nCoNtEnT-TyPe: TEXT/JAVASCRIPT; charset=utf-8\r\n\r\nfetch('/api/a')",
      ),
    ).toBe(true);
    expect(
      isJavaScriptResponse(
        "HTTP/1.1 200 OK\r\nContent-Type: application/javascript\r\n\r\n",
      ),
    ).toBe(true);
  });

  it("rejects MIME tokens in bodies and near-miss header values", () => {
    expect(
      isJavaScriptResponse(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n// Content-Type: text/javascript",
      ),
    ).toBe(false);
    expect(
      isJavaScriptResponse(
        "HTTP/1.1 200 OK\r\nContent-Type: text/javascript-extra\r\n\r\n",
      ),
    ).toBe(false);
  });
});

describe("groupAssetsByHost", () => {
  const requests: ObservedAssetRequest[] = [
    { host: "app.example.com", path: "/a/main.js", statusCode: 200 },
    { host: "app.example.com", path: "/a/vendor.js", statusCode: 200 },
    { host: "app.example.com", path: "/a/main.js.map", statusCode: 200 },
    { host: "cdn.example.com", path: "/lib.js" },
    { host: "cdn.example.com", path: "/data.json", statusCode: 200 },
  ];

  it("lists MIME-confirmed scripts and pairs captured maps without adding decoys", () => {
    const grouped = groupAssetsByHost([
      {
        host: "app.example.com",
        path: "/assets/entry?build=2",
        statusCode: 200,
        isJavaScript: true,
      },
      { host: "app.example.com", path: "/assets/entry.map", statusCode: 200 },
      {
        host: "app.example.com",
        path: "/assets/decoy",
        statusCode: 200,
        isJavaScript: false,
      },
    ]);
    expect(grouped.get("app.example.com")).toMatchObject({
      bundleCount: 1,
      mapCount: 1,
      bundles: [{ path: "/assets/entry", requestCount: 1, hasMap: true }],
    });
  });

  it("keeps the captured scheme, port, and query variants for copied bundles", () => {
    const host = groupAssetsByHost([
      {
        host: "app.example.com",
        path: "/assets/runtime",
        query: "v=2",
        isTls: false,
        port: 4177,
        isJavaScript: true,
      },
      {
        host: "app.example.com",
        path: "/assets/runtime",
        query: "v=1",
        isTls: true,
        port: 8443,
        isJavaScript: true,
      },
      {
        host: "app.example.com",
        path: "/assets/runtime",
        query: "v=1",
        isTls: false,
        port: 4177,
        isJavaScript: true,
      },
      {
        host: "app.example.com",
        path: "/assets/runtime",
        query: "v=3",
        isTls: true,
        port: 443,
        isJavaScript: true,
      },
      { host: "app.example.com", path: "/unknown.js" },
    ]).get("app.example.com");
    expect(
      host?.bundles.find((bundle) => bundle.path === "/assets/runtime")?.urls,
    ).toEqual([
      "http://app.example.com:4177/assets/runtime?v=1",
      "http://app.example.com:4177/assets/runtime?v=2",
      "https://app.example.com/assets/runtime?v=3",
      "https://app.example.com:8443/assets/runtime?v=1",
    ]);
    expect(
      host?.bundles.find((bundle) => bundle.path === "/unknown.js")?.urls,
    ).toEqual([]);
  });

  it("links each URL to a successful capture instead of a revalidation", () => {
    const host = groupAssetsByHost([
      {
        host: "app.example.com",
        path: "/bundle.js",
        query: "v=1",
        isTls: false,
        port: 4177,
        requestId: "earlier-body",
        statusCode: 200,
        seenAt: "2026-11-07T10:00:00Z",
      },
      {
        host: "app.example.com",
        path: "/bundle.js",
        query: "v=1",
        isTls: false,
        port: 4177,
        requestId: "latest-revalidation",
        statusCode: 304,
        seenAt: "2026-11-07T12:00:00Z",
      },
      {
        host: "app.example.com",
        path: "/bundle.js",
        query: "v=2",
        isTls: false,
        port: 4177,
        requestId: "second-variant",
        statusCode: 200,
        seenAt: "2026-11-07T11:00:00Z",
      },
      {
        host: "app.example.com",
        path: "/bundle.js",
        query: "v=1",
        isTls: false,
        port: 4177,
        requestId: "newer-body",
        statusCode: 200,
        seenAt: "2026-11-07T11:30:00Z",
      },
      { host: "app.example.com", path: "/unknown.js", requestId: "unknown" },
    ]).get("app.example.com");
    expect(host?.bundles[0]?.requestIdsByUrl).toEqual({
      "http://app.example.com:4177/bundle.js?v=1": "newer-body",
      "http://app.example.com:4177/bundle.js?v=2": "second-variant",
    });
    expect(host?.bundles[1]?.requestIdsByUrl).toEqual({});
  });

  it("groups, dedupes, counts, and pairs maps", () => {
    const grouped = groupAssetsByHost(requests);
    const app = grouped.get("app.example.com");
    expect(app?.bundleCount).toBe(2);
    expect(app?.mapCount).toBe(1);
    expect(app?.bundles).toMatchObject([
      { path: "/a/main.js", requestCount: 1, lastStatus: 200, hasMap: true },
      { path: "/a/vendor.js", requestCount: 1, lastStatus: 200, hasMap: false },
    ]);
    const cdn = grouped.get("cdn.example.com");
    expect(cdn?.bundleCount).toBe(1);
    expect(cdn?.bundles[0]?.lastStatus).toBeUndefined();
    expect(cdn?.bundles[0]?.hasMap).toBe(false);
  });

  it("ignores failed responses as phantom assets", () => {
    const withFailures: ObservedAssetRequest[] = [
      { host: "app.example.com", path: "/a/ghost.js", statusCode: 404 },
      { host: "app.example.com", path: "/a/real.js", statusCode: 200 },
      { host: "app.example.com", path: "/a/ghost.js.map", statusCode: 500 },
    ];
    const app = groupAssetsByHost(withFailures).get("app.example.com");
    expect(app?.bundleCount).toBe(1);
    expect(app?.bundles[0]?.path).toBe("/a/real.js");
    expect(app?.mapCount).toBe(0);
  });

  it("tracks first/last seen per bundle and last seen per host", () => {
    const timed: ObservedAssetRequest[] = [
      {
        host: "app.example.com",
        path: "/a/main.js",
        statusCode: 200,
        seenAt: "2026-08-01T10:00:00Z",
      },
      {
        host: "app.example.com",
        path: "/a/main.js",
        statusCode: 200,
        seenAt: "2026-08-03T10:00:00Z",
      },
      {
        host: "app.example.com",
        path: "/a/vendor.js",
        statusCode: 200,
        seenAt: "2026-08-05T10:00:00Z",
      },
    ];
    const app = groupAssetsByHost(timed).get("app.example.com");
    expect(app?.bundles[0]?.firstSeen).toBe("2026-08-01T10:00:00Z");
    expect(app?.bundles[0]?.lastSeen).toBe("2026-08-03T10:00:00Z");
    expect(app?.bundles[1]?.lastSeen).toBe("2026-08-05T10:00:00Z");
    expect(app?.lastSeen).toBe("2026-08-05T10:00:00Z");
  });

  it("normalizes timestamps to ISO at ingestion", () => {
    expect(normalizeSeenAt(1786049639985)).toBe(
      new Date(1786049639985).toISOString(),
    );
    expect(normalizeSeenAt("1786049639985")).toBe(
      new Date(1786049639985).toISOString(),
    );
    expect(normalizeSeenAt("2026-08-01T10:00:00Z")).toBe(
      "2026-08-01T10:00:00Z",
    );
    expect(normalizeSeenAt(new Date("2026-08-01T10:00:00Z"))).toBe(
      "2026-08-01T10:00:00.000Z",
    );
    expect(normalizeSeenAt(undefined)).toBeUndefined();
    expect(normalizeSeenAt("")).toBeUndefined();
  });

  it("counts map sightings toward host lastSeen", () => {
    const timed: ObservedAssetRequest[] = [
      {
        host: "app.example.com",
        path: "/a/old.js",
        statusCode: 200,
        seenAt: "2026-07-01T10:00:00Z",
      },
      {
        host: "app.example.com",
        path: "/a/old.js.map",
        statusCode: 200,
        seenAt: "2026-08-10T10:00:00Z",
      },
      {
        host: "maps-only.example.com",
        path: "/x.js.map",
        statusCode: 200,
        seenAt: "2026-08-09T10:00:00Z",
      },
    ];
    const grouped = groupAssetsByHost(timed);
    expect(grouped.get("app.example.com")?.lastSeen).toBe(
      "2026-08-10T10:00:00Z",
    );
    expect(grouped.get("maps-only.example.com")?.lastSeen).toBe(
      "2026-08-09T10:00:00Z",
    );
  });

  it("produces deterministic host ordering", () => {
    expect([...groupAssetsByHost(requests).keys()]).toEqual([
      "app.example.com",
      "cdn.example.com",
    ]);
  });
});
