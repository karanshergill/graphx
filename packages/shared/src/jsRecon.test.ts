import { describe, expect, it } from "vitest";

import { extractJsRecon, mergeJsRecon } from "./jsRecon";

describe("extractJsRecon", () => {
  it("extracts path-like and absolute URL endpoints, deduped and sorted", () => {
    const source = `
      fetch("/api/users");
      axios.get("/api/users");
      const health = '/api/health';
      const cdn = "https://cdn.example.com/lib.js";
      fetch("/api/users");
    `;
    const result = extractJsRecon(source);
    expect(result.endpoints).toEqual([
      "/api/health",
      "/api/users",
      "https://cdn.example.com/lib.js",
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

  it("caps the endpoint list", () => {
    const source = Array.from(
      { length: 250 },
      (_, index) =>
        `fetch("/api/resource-${index.toString().padStart(3, "0")}");`,
    ).join("\n");
    expect(extractJsRecon(source).endpoints).toHaveLength(200);
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
});
