import type { ApiRoute } from "./apiMap";

export type RouteTreeNode = {
  id: string;
  segment: string;
  depth: number;
  children: RouteTreeNode[];
  endpoint?: ApiRoute;
};

const ROOT_ID = "/";

const isParamSegment = (segment: string): boolean =>
  segment === "{id}" || segment === "{param}";

const sortChildren = (children: RouteTreeNode[]): void => {
  children.sort((left, right) => {
    const leftParam = isParamSegment(left.segment) ? 1 : 0;
    const rightParam = isParamSegment(right.segment) ? 1 : 0;
    return leftParam - rightParam || left.segment.localeCompare(right.segment);
  });
  for (const child of children) sortChildren(child.children);
};

export const buildRouteTree = (routes: readonly ApiRoute[]): RouteTreeNode => {
  const root: RouteTreeNode = {
    id: ROOT_ID,
    segment: "",
    depth: 0,
    children: [],
  };
  const byId = new Map<string, RouteTreeNode>([[ROOT_ID, root]]);

  const sorted = [...routes].sort((left, right) =>
    left.template.localeCompare(right.template),
  );
  for (const route of sorted) {
    const segments = route.template
      .split("/")
      .filter((segment) => segment.length > 0);
    let parent = root;
    segments.forEach((segment, index) => {
      const id = `${parent.id === ROOT_ID ? "" : parent.id}/${segment}`;
      let node = byId.get(id);
      if (node === undefined) {
        node = {
          id,
          segment,
          depth: index + 1,
          children: [],
        };
        byId.set(id, node);
        parent.children.push(node);
      }
      parent = node;
    });
    parent.endpoint = route;
  }

  sortChildren(root.children);
  return root;
};

export type RouteTreeLayout = Map<string, { x: number; y: number }>;

export const layoutRouteTree = (root: RouteTreeNode): RouteTreeLayout => {
  const positions: RouteTreeLayout = new Map();
  let nextLeafY = 0;

  const visit = (node: RouteTreeNode): number => {
    let y: number;
    if (node.children.length === 0) {
      y = nextLeafY;
      nextLeafY += 1;
    } else {
      const childYs = node.children.map(visit);
      y = (Math.min(...childYs) + Math.max(...childYs)) / 2;
    }
    positions.set(node.id, { x: node.depth, y });
    return y;
  };

  visit(root);
  return positions;
};

export const countRouteTreeEndpoints = (root: RouteTreeNode): number => {
  let count = 0;
  const visit = (node: RouteTreeNode): void => {
    if (node.endpoint !== undefined) count += 1;
    for (const child of node.children) visit(child);
  };
  visit(root);
  return count;
};
