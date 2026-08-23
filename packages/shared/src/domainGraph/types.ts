export type ScopeDefinition = {
  id: string;
  name: string;
  allowlist: string[];
  denylist: string[];
};

export type SitemapDomainEntry = {
  id: string;
  label: string;
};

export type DomainNodeKind = "root-domain" | "subdomain";

export type DomainNode = {
  id: string;
  hostname: string;
  label: string;
  kind: DomainNodeKind;
  depth: number;
  observed: boolean;
  sitemapEntryIds: string[];
};

export type DomainRelationship = {
  id: string;
  source: string;
  target: string;
  kind: "parent-domain";
};

export type DomainGraphStats = {
  sitemapEntries: number;
  excludedEntries: number;
  observedHosts: number;
  observedSubdomains: number;
  structuralHosts: number;
  rootDomains: number;
  relationships: number;
  maxDepth: number;
};

export type DomainGraphSnapshot = {
  source: "caido-sitemap";
  generatedAt: string;
  scope: ScopeDefinition;
  nodes: DomainNode[];
  relationships: DomainRelationship[];
  stats: DomainGraphStats;
};

export type DomainGraphProjection = Pick<
  DomainGraphSnapshot,
  "nodes" | "relationships"
>;
