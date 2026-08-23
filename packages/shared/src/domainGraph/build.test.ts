import { describe, expect, it } from "vitest";

import { buildDomainGraph } from "./build";
import type { ScopeDefinition, SitemapDomainEntry } from "./types";

const scope: ScopeDefinition = {
  id: "scope-1",
  name: "Program",
  allowlist: ["example.com", "*.example.com", "isolated.other.test"],
  denylist: ["blocked.example.com"],
};

const entries: SitemapDomainEntry[] = [
  { id: "1", label: "example.com" },
  { id: "2", label: "api.stage.example.com" },
  { id: "3", label: "API.STAGE.EXAMPLE.COM." },
  { id: "4", label: "blocked.example.com" },
  { id: "5", label: "foreign.test" },
  { id: "6", label: "isolated.other.test" },
];

describe("buildDomainGraph", () => {
  const graph = buildDomainGraph({
    scope,
    entries,
    generatedAt: "2026-08-04T00:00:00.000Z",
  });

  it("deduplicates Sitemap transport roots by hostname", () => {
    expect(graph.stats.observedHosts).toBe(3);
    expect(
      graph.nodes.find((node) => node.hostname === "api.stage.example.com")
        ?.sitemapEntryIds,
    ).toEqual(["2", "3"]);
  });

  it("creates only in-scope structural parents", () => {
    expect(graph.nodes.map((node) => node.hostname)).toEqual([
      "example.com",
      "isolated.other.test",
      "stage.example.com",
      "api.stage.example.com",
    ]);
    expect(graph.nodes.some((node) => node.hostname === "other.test")).toBe(
      false,
    );
  });

  it("derives stable immediate-parent relationships and depths", () => {
    expect(graph.relationships).toEqual([
      {
        id: "parent-domain:example.com->stage.example.com",
        source: "domain:example.com",
        target: "domain:stage.example.com",
        kind: "parent-domain",
      },
      {
        id: "parent-domain:stage.example.com->api.stage.example.com",
        source: "domain:stage.example.com",
        target: "domain:api.stage.example.com",
        kind: "parent-domain",
      },
    ]);
    expect(graph.stats.maxDepth).toBe(2);
    expect(graph.stats.structuralHosts).toBe(1);
  });

  it("records excluded Sitemap roots without exposing them", () => {
    expect(graph.stats.sitemapEntries).toBe(4);
    expect(graph.stats.excludedEntries).toBe(2);
    expect(graph.nodes.some((node) => node.hostname === "foreign.test")).toBe(
      false,
    );
    expect(
      graph.nodes.some((node) => node.hostname === "blocked.example.com"),
    ).toBe(false);
  });
});
