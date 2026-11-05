import { describe, expect, it } from "vitest";

import {
  extractJsRecon,
  extractSourceMapRecon,
  findSourceMapRef,
  mergeJsRecon,
  normalizeThrottleMs,
} from "./jsRecon";

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

  it("extracts endpoints from template literals, keeping interpolations", () => {
    const source = [
      "fetch(`/api/users/${userId}`);",
      "fetch(`/api/health`);",
      "const junk = `hello ${name} world`;",
      "const url = `https://api.example.com/v2/items/${id}`;",
    ].join("\n");
    expect(extractJsRecon(source).endpoints).toEqual([
      "/api/health",
      "/api/users/${userId}",
      "https://api.example.com/v2/items/${id}",
    ]);
  });

  it("records every lead's first multiline bundle position and captured origin", () => {
    const source = [
      'fetch("/api/v1");',
      '"query Viewer { user }";',
      'localStorage.getItem("token");',
      "el.innerHTML = user;",
      'addEventListener("message", fn);',
      "x.postMessage(v);",
      'fetch("/api/v1");',
    ].join("\n");
    expect(
      extractJsRecon(source, {
        assetPath: "/assets/app.js?v=1",
        requestId: "bundle-42",
      }).evidence,
    ).toEqual([
      {
        kind: "endpoint",
        value: "/api/v1",
        assetPath: "/assets/app.js?v=1",
        requestId: "bundle-42",
        line: 1,
        column: 8,
      },
      {
        kind: "graphql-operation",
        value: "Viewer",
        assetPath: "/assets/app.js?v=1",
        requestId: "bundle-42",
        line: 2,
        column: 2,
      },
      {
        kind: "post-message-call",
        value: "postMessage",
        assetPath: "/assets/app.js?v=1",
        requestId: "bundle-42",
        line: 6,
        column: 1,
      },
      {
        kind: "post-message-handler",
        value: "message",
        assetPath: "/assets/app.js?v=1",
        requestId: "bundle-42",
        line: 5,
        column: 1,
      },
      {
        kind: "sink",
        value: "innerHTML",
        assetPath: "/assets/app.js?v=1",
        requestId: "bundle-42",
        line: 4,
        column: 3,
      },
      {
        kind: "storage-key",
        value: "token",
        assetPath: "/assets/app.js?v=1",
        requestId: "bundle-42",
        line: 3,
        column: 23,
      },
    ]);
  });

  it("records representatives for each sink name without changing counts", () => {
    const result = extractJsRecon(
      "eval(a); document.write(a); el.outerHTML = a; new Function(a); " +
        "el.insertAdjacentHTML('beforeend', a); dangerouslySetInnerHTML;",
    );
    expect(result.sinks).toEqual({
      dangerouslySetInnerHTML: 1,
      "document.write": 1,
      eval: 1,
      insertAdjacentHTML: 1,
      "new Function": 1,
      outerHTML: 1,
    });
    expect(
      result.evidence
        .filter((evidence) => evidence.kind === "sink")
        .map(({ value }) => value),
    ).toEqual([
      "dangerouslySetInnerHTML",
      "document.write",
      "eval",
      "insertAdjacentHTML",
      "new Function",
      "outerHTML",
    ]);
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
      evidence: [],
    };
    expect(mergeJsRecon([legacy]).endpoints).toEqual(["/api/a"]);
    expect(mergeJsRecon([legacy]).evidence).toEqual([]);
  });

  it("prefers original modules, then stable source, request, and location", () => {
    const bundle = extractJsRecon('fetch("/api/shared");', {
      assetPath: "/app.js",
      requestId: "bundle",
    });
    const later = extractJsRecon('\nfetch("/api/shared");', {
      assetPath: "/app.js.map",
      sourcePath: "webpack:///z.ts",
      requestId: "map-z",
    });
    const earlier = extractJsRecon('fetch("/api/shared");', {
      assetPath: "/app.js.map",
      sourcePath: "webpack:///a.ts",
      requestId: "map-a",
    });
    const expected = earlier.evidence[0];
    expect(mergeJsRecon([bundle, later, earlier]).evidence).toEqual([expected]);
    expect(mergeJsRecon([earlier, later, bundle]).evidence).toEqual([expected]);

    const sameSource = extractJsRecon('\nfetch("/api/shared");', {
      assetPath: "/app.js.map",
      sourcePath: "webpack:///a.ts",
      requestId: "map-a",
    });
    expect(mergeJsRecon([sameSource, earlier]).evidence).toEqual([expected]);

    const lowerId = extractJsRecon('fetch("/api/shared");', {
      assetPath: "/app.js.map",
      sourcePath: "webpack:///a.ts",
      requestId: "map-0",
    });
    expect(mergeJsRecon([earlier, lowerId]).evidence).toEqual([
      lowerId.evidence[0],
    ]);
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

    const bundled = extractJsRecon('fetch("/api/users");', {
      assetPath: "/app.js",
      requestId: "bundle",
    });
    expect(mergeJsRecon([bundled, recon!.extraction]).evidence).toContainEqual({
      kind: "endpoint",
      value: "/api/users",
      sourcePath: "webpack://app/./src/auth.ts",
      line: 1,
      column: 8,
    });
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

  it("ties sourcesContent to its original module position and captured map", () => {
    const map = JSON.stringify({
      version: 3,
      sources: ["src/skip.ts", "src/original.ts"],
      sourcesContent: [
        null,
        'const ignored = 1;\nfetch("/api/original");\n"query Original { viewer }";',
      ],
    });
    expect(
      extractSourceMapRecon(map, {
        assetPath: "/assets/app.js.map",
        requestId: "map-43",
      })?.extraction.evidence,
    ).toEqual([
      {
        kind: "endpoint",
        value: "/api/original",
        assetPath: "/assets/app.js.map",
        sourcePath: "src/original.ts",
        requestId: "map-43",
        line: 2,
        column: 8,
      },
      {
        kind: "graphql-operation",
        value: "Original",
        assetPath: "/assets/app.js.map",
        sourcePath: "src/original.ts",
        requestId: "map-43",
        line: 3,
        column: 2,
      },
    ]);
  });

  it("never invents a request ID for actively fetched maps", () => {
    const map = JSON.stringify({
      version: 3,
      sources: ["src/api.ts"],
      sourcesContent: ['fetch("/api/live");'],
    });
    expect(
      extractSourceMapRecon(map, { assetPath: "/assets/app.js.map" })
        ?.extraction.evidence,
    ).toEqual([
      {
        kind: "endpoint",
        value: "/api/live",
        assetPath: "/assets/app.js.map",
        sourcePath: "src/api.ts",
        line: 1,
        column: 8,
      },
    ]);
  });
});

describe("findSourceMapRef", () => {
  it("returns the last sourceMappingURL reference", () => {
    const source =
      "code();\n//# sourceMappingURL=first.js.map\nmore();\n//# sourceMappingURL=last.js.map\n";
    expect(findSourceMapRef(source)).toBe("last.js.map");
  });

  it("handles absolute and data-URI references", () => {
    expect(
      findSourceMapRef("//# sourceMappingURL=https://cdn.example.com/a.js.map"),
    ).toBe("https://cdn.example.com/a.js.map");
    expect(
      findSourceMapRef(
        "//# sourceMappingURL=data:application/json;base64,eyJ9",
      ),
    ).toBe("data:application/json;base64,eyJ9");
  });

  it("returns undefined when no reference exists", () => {
    expect(findSourceMapRef("const a = 1;")).toBeUndefined();
  });
});

describe("normalizeThrottleMs", () => {
  it("falls back to the default for missing or invalid values", () => {
    expect(normalizeThrottleMs(undefined)).toBe(2_000);
    expect(normalizeThrottleMs(null)).toBe(2_000);
    expect(normalizeThrottleMs("")).toBe(2_000);
    expect(normalizeThrottleMs("abc")).toBe(2_000);
    expect(normalizeThrottleMs(-5)).toBe(2_000);
  });

  it("accepts numbers and numeric strings, floored; 0 disables", () => {
    expect(normalizeThrottleMs(500)).toBe(500);
    expect(normalizeThrottleMs("750")).toBe(750);
    expect(normalizeThrottleMs(250.7)).toBe(250);
    expect(normalizeThrottleMs(0)).toBe(0);
  });
});
