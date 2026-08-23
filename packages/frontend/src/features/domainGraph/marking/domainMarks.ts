import type { DomainGraphProjection } from "shared";

export type DomainConnectionPath = {
  nodes: ReadonlySet<string>;
  relationships: ReadonlySet<string>;
};

export const collectDescendants = (
  projection: DomainGraphProjection,
  hostname: string,
): string[] => {
  const hostnameById = new Map(
    projection.nodes.map((node) => [node.id, node.hostname]),
  );
  const childrenByParent = new Map<string, string[]>();
  for (const relationship of projection.relationships) {
    const children = childrenByParent.get(relationship.source) ?? [];
    children.push(relationship.target);
    childrenByParent.set(relationship.source, children);
  }

  const descendants = new Set<string>();
  const queue = [`domain:${hostname}`];
  for (
    let current = queue.shift();
    current !== undefined;
    current = queue.shift()
  ) {
    for (const child of childrenByParent.get(current) ?? []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      queue.push(child);
    }
  }

  const hostnames: string[] = [];
  for (const id of descendants) {
    const descendant = hostnameById.get(id);
    if (descendant !== undefined) hostnames.push(descendant);
  }
  return hostnames.sort((left, right) => left.localeCompare(right));
};

export const collectConnectionPath = (
  projection: DomainGraphProjection,
  marks: ReadonlySet<string>,
): DomainConnectionPath => {
  const nodeIds = new Set(projection.nodes.map((node) => node.id));
  const parentByChild = new Map<string, string>();
  const relationshipByChild = new Map<string, string>();
  for (const relationship of projection.relationships) {
    parentByChild.set(relationship.target, relationship.source);
    relationshipByChild.set(relationship.target, relationship.id);
  }

  const nodes = new Set<string>();
  const relationships = new Set<string>();
  for (const hostname of [...marks].sort()) {
    let current = `domain:${hostname}`;
    if (!nodeIds.has(current)) continue;
    while (!nodes.has(current)) {
      nodes.add(current);
      const parent = parentByChild.get(current);
      const relationship = relationshipByChild.get(current);
      if (parent === undefined || relationship === undefined) break;
      relationships.add(relationship);
      current = parent;
    }
  }
  return { nodes, relationships };
};

export const projectMarkedSubgraph = (
  projection: DomainGraphProjection,
  marks: ReadonlySet<string>,
): DomainGraphProjection => {
  if (marks.size === 0) return projection;
  const path = collectConnectionPath(projection, marks);
  return {
    nodes: projection.nodes.filter((node) => path.nodes.has(node.id)),
    relationships: projection.relationships.filter(
      (relationship) =>
        path.nodes.has(relationship.source) &&
        path.nodes.has(relationship.target),
    ),
  };
};
