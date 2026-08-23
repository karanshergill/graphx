import { normalizeHostname, parentHostname } from "./hostname";
import { createScopeMatcher } from "./scope";
import type {
  DomainGraphSnapshot,
  DomainNode,
  DomainRelationship,
  ScopeDefinition,
  SitemapDomainEntry,
} from "./types";

type BuildDomainGraphInput = {
  scope: ScopeDefinition;
  entries: SitemapDomainEntry[];
  generatedAt: string;
};

export const buildDomainGraph = ({
  scope,
  entries,
  generatedAt,
}: BuildDomainGraphInput): DomainGraphSnapshot => {
  const matchesScope = createScopeMatcher(scope);
  const observedEntryIds = new Map<string, Set<string>>();
  let sitemapEntries = 0;

  for (const entry of entries) {
    const hostname = normalizeHostname(entry.label);
    if (hostname === undefined || !matchesScope(hostname)) continue;

    sitemapEntries += 1;
    const ids = observedEntryIds.get(hostname) ?? new Set<string>();
    ids.add(entry.id);
    observedEntryIds.set(hostname, ids);
  }

  const hostnames = new Set(observedEntryIds.keys());
  for (const hostname of observedEntryIds.keys()) {
    let parent = parentHostname(hostname);
    while (parent !== undefined) {
      if (matchesScope(parent)) hostnames.add(parent);
      parent = parentHostname(parent);
    }
  }

  const parents = new Map<string, string>();
  for (const hostname of hostnames) {
    const parent = parentHostname(hostname);
    if (parent !== undefined && hostnames.has(parent)) {
      parents.set(hostname, parent);
    }
  }

  const depths = new Map<string, number>();
  const getDepth = (hostname: string): number => {
    const current = depths.get(hostname);
    if (current !== undefined) return current;
    const parent = parents.get(hostname);
    const depth = parent === undefined ? 0 : getDepth(parent) + 1;
    depths.set(hostname, depth);
    return depth;
  };

  const nodes: DomainNode[] = Array.from(hostnames, (hostname): DomainNode => {
    const depth = getDepth(hostname);
    return {
      id: `domain:${hostname}`,
      hostname,
      label: hostname,
      kind: depth === 0 ? "root-domain" : "subdomain",
      depth,
      observed: observedEntryIds.has(hostname),
      sitemapEntryIds: Array.from(observedEntryIds.get(hostname) ?? []).sort(),
    };
  }).sort(
    (left, right) =>
      left.depth - right.depth || left.hostname.localeCompare(right.hostname),
  );

  const relationships: DomainRelationship[] = Array.from(
    parents,
    ([hostname, parent]): DomainRelationship => ({
      id: `parent-domain:${parent}->${hostname}`,
      source: `domain:${parent}`,
      target: `domain:${hostname}`,
      kind: "parent-domain",
    }),
  ).sort((left, right) => left.id.localeCompare(right.id));

  return {
    source: "caido-sitemap",
    generatedAt,
    scope,
    nodes,
    relationships,
    stats: {
      sitemapEntries,
      excludedEntries: entries.length - sitemapEntries,
      observedHosts: observedEntryIds.size,
      observedSubdomains: nodes.filter(
        (node) => node.observed && node.depth > 0,
      ).length,
      structuralHosts: nodes.filter((node) => !node.observed).length,
      rootDomains: nodes.filter((node) => node.depth === 0).length,
      relationships: relationships.length,
      maxDepth: nodes.reduce(
        (maximum, node) => Math.max(maximum, node.depth),
        0,
      ),
    },
  };
};
