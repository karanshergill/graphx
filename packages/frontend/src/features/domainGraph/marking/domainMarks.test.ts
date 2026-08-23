import type { DomainGraphProjection, DomainNode } from "shared";
import { describe, expect, it } from "vitest";

import {
  collectConnectionPath,
  collectDescendants,
  projectMarkedSubgraph,
} from "./domainMarks";

const node = (hostname: string, depth: number): DomainNode => ({
  id: `domain:${hostname}`,
  hostname,
  label: hostname,
  kind: depth === 0 ? "root-domain" : "subdomain",
  depth,
  observed: true,
  sitemapEntryIds: [],
});

const relationship = (parent: string, child: string) => ({
  id: `parent-domain:${parent}->${child}`,
  source: `domain:${parent}`,
  target: `domain:${child}`,
  kind: "parent-domain" as const,
});

const projection = (): DomainGraphProjection => ({
  nodes: [
    node("example.com", 0),
    node("stage.example.com", 1),
    node("api.stage.example.com", 2),
    node("static.stage.example.com", 2),
    node("other.com", 0),
  ],
  relationships: [
    relationship("example.com", "stage.example.com"),
    relationship("stage.example.com", "api.stage.example.com"),
    relationship("stage.example.com", "static.stage.example.com"),
  ],
});

describe("collectDescendants", () => {
  it("collects the full subtree in deterministic order", () => {
    expect(collectDescendants(projection(), "example.com")).toEqual([
      "api.stage.example.com",
      "stage.example.com",
      "static.stage.example.com",
    ]);
  });

  it("returns an empty list for a leaf node", () => {
    expect(collectDescendants(projection(), "api.stage.example.com")).toEqual(
      [],
    );
  });
});

describe("collectConnectionPath", () => {
  it("walks a single mark's lineage to its root", () => {
    const path = collectConnectionPath(
      projection(),
      new Set(["api.stage.example.com"]),
    );
    expect(path.nodes).toEqual(
      new Set([
        "domain:api.stage.example.com",
        "domain:stage.example.com",
        "domain:example.com",
      ]),
    );
    expect(path.relationships).toEqual(
      new Set([
        "parent-domain:example.com->stage.example.com",
        "parent-domain:stage.example.com->api.stage.example.com",
      ]),
    );
  });

  it("unions chains so two marks expose their shared ancestor", () => {
    const path = collectConnectionPath(
      projection(),
      new Set(["api.stage.example.com", "static.stage.example.com"]),
    );
    expect(path.nodes).toEqual(
      new Set([
        "domain:api.stage.example.com",
        "domain:static.stage.example.com",
        "domain:stage.example.com",
        "domain:example.com",
      ]),
    );
    expect(path.relationships.size).toBe(3);
  });

  it("keeps disconnected trees separate", () => {
    const path = collectConnectionPath(
      projection(),
      new Set(["api.stage.example.com", "other.com"]),
    );
    expect(path.nodes).toContain("domain:other.com");
    expect(path.nodes.size).toBe(4);
    expect(path.relationships.size).toBe(2);
  });

  it("ignores marks that are not in the projection and empty mark sets", () => {
    const empty = collectConnectionPath(projection(), new Set());
    expect(empty.nodes.size).toBe(0);
    expect(empty.relationships.size).toBe(0);
    const missing = collectConnectionPath(
      projection(),
      new Set(["absent.example.com"]),
    );
    expect(missing.nodes.size).toBe(0);
  });
});

describe("projectMarkedSubgraph", () => {
  it("passes the projection through when nothing is marked", () => {
    const source = projection();
    expect(projectMarkedSubgraph(source, new Set())).toBe(source);
  });

  it("keeps marked nodes with their ancestor chains only", () => {
    const filtered = projectMarkedSubgraph(
      projection(),
      new Set(["static.stage.example.com"]),
    );
    expect(filtered.nodes.map((entry) => entry.hostname)).toEqual([
      "example.com",
      "stage.example.com",
      "static.stage.example.com",
    ]);
    expect(filtered.relationships.map((entry) => entry.id)).toEqual([
      "parent-domain:example.com->stage.example.com",
      "parent-domain:stage.example.com->static.stage.example.com",
    ]);
  });
});
