import { describe, expect, it } from "vitest";

import {
  classifyAssetPath,
  groupAssetsByHost,
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
});

describe("groupAssetsByHost", () => {
  const requests: ObservedAssetRequest[] = [
    { host: "app.example.com", path: "/a/main.js", statusCode: 200 },
    { host: "app.example.com", path: "/a/main.js", statusCode: 304 },
    { host: "app.example.com", path: "/a/vendor.js", statusCode: 200 },
    { host: "app.example.com", path: "/a/main.js.map", statusCode: 200 },
    { host: "cdn.example.com", path: "/lib.js" },
    { host: "cdn.example.com", path: "/data.json", statusCode: 200 },
  ];

  it("groups, dedupes, counts, and pairs maps", () => {
    const grouped = groupAssetsByHost(requests);
    const app = grouped.get("app.example.com");
    expect(app?.bundleCount).toBe(2);
    expect(app?.mapCount).toBe(1);
    expect(app?.bundles).toEqual([
      { path: "/a/main.js", requestCount: 2, lastStatus: 304, hasMap: true },
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
