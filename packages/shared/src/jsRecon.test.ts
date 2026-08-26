import { describe, expect, it } from "vitest";

import { extractJsRecon, extractSourceMapRecon, mergeJsRecon } from "./jsRecon";

describe("extractJsRecon", () => {
  it("extracts path-like and absolute URL endpoints, deduped and sorted", () => {
    const source = `
      fetch("/api/users");
      axios.get("/api/users");
      const health = '/api/health';
      const cdn = "https://cdn.example.com/lib/main";
      fetch("/api/users");
    `;
    const result = extractJsRecon(source);
    expect(result.endpoints).toEqual([
      "/api/health",
      "/api/users",
      "https://cdn.example.com/lib/main",
    ]);
  });

  it("ignores non-endpoint strings", () => {
    const source = `
      const label = "just some words";
      const proto = "//cdn.example.com/x.js";
      const root = "/";
      const tpl = "hello world";
    `;
    expect(extractJsRecon(source).endpoints).toEqual([]);
  });

  it("extracts GraphQL operation names", () => {
    const source = `
      const q = "query GetUser($id: ID!) { user(id: $id) { name } }";
      const m = "mutation UpdateUser($name: String!) { update }";
      const s = 'subscription OnUpdate { changed }';
    `;
    expect(extractJsRecon(source).graphqlOperations).toEqual([
      "GetUser",
      "OnUpdate",
      "UpdateUser",
    ]);
  });

  it("extracts storage keys from localStorage and sessionStorage", () => {
    const source = `
      localStorage.getItem("auth_token");
      sessionStorage.setItem('draft', value);
      localStorage.removeItem("auth_token");
    `;
    expect(extractJsRecon(source).storageKeys).toEqual(["auth_token", "draft"]);
  });

  it("counts message listeners and postMessage calls", () => {
    const source = `
      window.addEventListener("message", handler);
      worker.onmessage = handler;
      iframe.contentWindow.postMessage(data, "*");
      window.postMessage(data, "/");
    `;
    const result = extractJsRecon(source);
    expect(result.postMessageHandlers).toBe(2);
    expect(result.postMessageCalls).toBe(2);
  });

  it("counts dangerous sinks, omitting absent ones", () => {
    const source = `
      el.innerHTML = payload;
      el.innerHTML = other;
      eval(code);
      document.write("<p>");
    `;
    expect(extractJsRecon(source).sinks).toEqual({
      "document.write": 1,
      eval: 1,
      innerHTML: 2,
    });
  });

  it("returns every endpoint found, without a cap", () => {
    const source = Array.from(
      { length: 250 },
      (_, index) =>
        `fetch("/api/resource-${index.toString().padStart(3, "0")}");`,
    ).join("\n");
    expect(extractJsRecon(source).endpoints).toHaveLength(250);
  });

  it("drops static assets and bundler dev-server internals", () => {
    const source = `
      import "/assets/app-B7x2.js";
      const css = "/styles/main.css";
      const font = "/fonts/inter.woff2";
      const img = "https://cdn.example.com/logo.svg";
      const chunk = "/node_modules/.vite/deps/chunk-B7x2.js";
      const vite = "/@vite/client";
      const refresh = "/@react-refresh";
      fetch("/api/users");
      fetch("/config.json");
    `;
    expect(extractJsRecon(source).endpoints).toEqual([
      "/api/users",
      "/config.json",
    ]);
  });

  it("drops namespace and telemetry hosts, keeps localhost and API URLs", () => {
    const source = `
      const svgNs = "https://www.w3.org/2000/svg";
      const soap = "https://schemas.xmlsoap.org/soap/envelope/";
      const ga = "https://www.google-analytics.com/collect";
      const sentry = "https://o123.ingest.sentry.io/api/456/";
      fetch("https://api.example.com/v1/users");
      fetch("http://localhost:3000/api/debug");
    `;
    expect(extractJsRecon(source).endpoints).toEqual([
      "http://localhost:3000/api/debug",
      "https://api.example.com/v1/users",
    ]);
  });

  it("drops asset URLs even when they carry a query string", () => {
    const source = `const lib = "https://cdn.example.com/lib.js?v=1.2.3";`;
    expect(extractJsRecon(source).endpoints).toEqual([]);
  });
});

describe("mergeJsRecon", () => {
  it("unions lists and sums counts", () => {
    const left = extractJsRecon(
      'fetch("/api/a"); localStorage.getItem("k1"); el.innerHTML = x;',
    );
    const right = extractJsRecon(
      'fetch("/api/b"); localStorage.getItem("k2"); el.innerHTML = y; window.postMessage(d, "*");',
    );
    const merged = mergeJsRecon([left, right]);
    expect(merged.endpoints).toEqual(["/api/a", "/api/b"]);
    expect(merged.storageKeys).toEqual(["k1", "k2"]);
    expect(merged.sinks).toEqual({ innerHTML: 2 });
    expect(merged.postMessageCalls).toBe(1);
  });

  it("dedupes shared endpoints across bundles", () => {
    const both = extractJsRecon('fetch("/api/shared");');
    const merged = mergeJsRecon([both, both]);
    expect(merged.endpoints).toEqual(["/api/shared"]);
  });

  it("drops noise endpoints from stored extractions on merge", () => {
    const legacy = {
      endpoints: ["/api/a", "/assets/logo.png", "https://www.w3.org/2000/svg"],
      graphqlOperations: [],
      storageKeys: [],
      postMessageHandlers: 0,
      postMessageCalls: 0,
      sinks: {},
    };
    expect(mergeJsRecon([legacy]).endpoints).toEqual(["/api/a"]);
  });
});

describe("extractSourceMapRecon", () => {
  it("extracts from sourcesContent and returns the module tree", () => {
    const map = JSON.stringify({
      version: 3,
      sources: ["webpack://app/./src/api.ts", "webpack://app/./src/auth.ts"],
      sourcesContent: [
        'fetch("/api/from-map"); localStorage.getItem("map_token");',
        'fetch("/api/users"); const q = "query MapOp { viewer }";',
      ],
    });
    const recon = extractSourceMapRecon(map);
    expect(recon?.sources).toEqual([
      "webpack://app/./src/api.ts",
      "webpack://app/./src/auth.ts",
    ]);
    expect(recon?.extraction.endpoints).toEqual([
      "/api/from-map",
      "/api/users",
    ]);
    expect(recon?.extraction.storageKeys).toEqual(["map_token"]);
    expect(recon?.extraction.graphqlOperations).toEqual(["MapOp"]);
  });

  it("skips null sourcesContent entries", () => {
    const map = JSON.stringify({
      version: 3,
      sources: ["a.ts", "b.ts"],
      sourcesContent: [null, 'fetch("/api/kept");'],
    });
    const recon = extractSourceMapRecon(map);
    expect(recon?.extraction.endpoints).toEqual(["/api/kept"]);
  });

  it("returns sources even without sourcesContent", () => {
    const map = JSON.stringify({ version: 3, sources: ["a.ts"] });
    const recon = extractSourceMapRecon(map);
    expect(recon?.sources).toEqual(["a.ts"]);
    expect(recon?.extraction.endpoints).toEqual([]);
  });

  it("returns undefined for invalid JSON or missing sources", () => {
    expect(extractSourceMapRecon("not json")).toBeUndefined();
    expect(extractSourceMapRecon('{"version":3}')).toBeUndefined();
    expect(extractSourceMapRecon('"just a string"')).toBeUndefined();
  });
});
