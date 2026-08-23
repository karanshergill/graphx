import { DirectedGraph } from "graphology";
import {
  type ApiMapResponse,
  type ApiRoute,
  buildRouteTree,
  layoutRouteTree,
  type RouteTreeNode,
} from "shared";
import SigmaRenderer from "sigma";

import {
  createHoverLabelDrawer,
  type DomainPalette,
  readDomainPalette,
} from "../domainGraph/rendering/domainGraphModel";

const X_SPACING = 280;
const Y_SPACING = 26;

type NodeAttributes = {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  zIndex: number;
};

export type RouteTreeRenderer = {
  update: (apiMap: ApiMapResponse) => void;
  clearSelection: () => void;
  resetView: () => void;
  destroy: () => void;
};

const isParamSegment = (segment: string): boolean =>
  segment === "{id}" || segment === "{param}";

const endpointColor = (endpoint: ApiRoute, palette: DomainPalette): string => {
  const statuses = Object.keys(endpoint.statuses);
  if (statuses.some((status) => status.startsWith("5"))) return palette.danger;
  if (statuses.some((status) => status.startsWith("4")))
    return palette.neighbor;
  return palette.observed;
};

export const createRouteTreeRenderer = (
  container: HTMLElement,
  onSelect: (endpoint: ApiRoute | undefined) => void,
): RouteTreeRenderer => {
  const graph = new DirectedGraph<NodeAttributes>();
  let palette = readDomainPalette(container);
  let hoveredNode: string | undefined;
  let selectedNode: string | undefined;
  let endpoints = new Map<string, ApiRoute>();

  const renderer = new SigmaRenderer(graph, container, {
    defaultDrawNodeHover: createHoverLabelDrawer(() => palette),
    hideEdgesOnMove: false,
    hideLabelsOnMove: false,
    labelColor: { color: palette.label },
    labelDensity: 0.9,
    labelFont: "system-ui, sans-serif",
    labelGridCellSize: 110,
    labelRenderedSizeThreshold: 7,
    minCameraRatio: 0.02,
    maxCameraRatio: 10,
    renderEdgeLabels: false,
    stagePadding: 64,
    zIndex: true,
  });

  renderer.setSetting("nodeReducer", (node, data) => {
    const focus = hoveredNode ?? selectedNode;
    if (focus === undefined) return data;
    if (node === focus) {
      return {
        ...data,
        color: palette.selected,
        highlighted: true,
        size: data.size + 2,
        zIndex: 2,
      };
    }
    return { ...data, color: palette.mutedNode, zIndex: 0 };
  });

  renderer.setSetting("edgeReducer", (edge, data) => {
    const focus = hoveredNode ?? selectedNode;
    if (focus === undefined) return data;
    const [source, target] = graph.extremities(edge);
    return source === focus || target === focus
      ? { ...data, color: palette.neighbor, size: 1.6, zIndex: 1 }
      : { ...data, color: palette.mutedEdge, size: 0.5, zIndex: 0 };
  });

  renderer.on("enterNode", ({ node }) => {
    hoveredNode = node;
    renderer.scheduleRefresh();
  });
  renderer.on("leaveNode", () => {
    hoveredNode = undefined;
    renderer.scheduleRefresh();
  });
  renderer.on("clickNode", ({ node }) => {
    const endpoint = endpoints.get(node);
    if (endpoint === undefined) return;
    selectedNode = node;
    onSelect(endpoint);
    renderer.scheduleRefresh();
  });
  renderer.on("clickStage", () => {
    selectedNode = undefined;
    onSelect(undefined);
    renderer.scheduleRefresh();
  });

  const applyTheme = (): void => {
    palette = readDomainPalette(container);
    renderer.setSetting("labelColor", { color: palette.label });
    renderer.scheduleRefresh();
  };

  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, {
    attributeFilter: ["data-mode"],
    attributes: true,
  });
  const pluginRoot = container.closest("#plugin--graphx");
  if (pluginRoot !== null) {
    themeObserver.observe(pluginRoot, {
      attributeFilter: ["data-mode"],
      attributes: true,
    });
  }
  const resizeObserver = new ResizeObserver(() => renderer.resize());
  resizeObserver.observe(container);

  const addNodes = (
    node: RouteTreeNode,
    positions: Map<string, { x: number; y: number }>,
  ): void => {
    const position = positions.get(node.id);
    if (position === undefined) return;
    const endpoint = node.endpoint;
    const color = isParamSegment(node.segment)
      ? palette.path
      : endpoint !== undefined
        ? endpointColor(endpoint, palette)
        : palette.structural;
    graph.addNode(node.id, {
      x: position.x * X_SPACING,
      y: position.y * Y_SPACING,
      size: endpoint !== undefined ? 4 + Math.log2(endpoint.requests + 1) : 3,
      color,
      label: node.segment.length === 0 ? "/" : node.segment,
      zIndex: endpoint !== undefined ? 1 : 0,
    });
    if (endpoint !== undefined) endpoints.set(node.id, endpoint);
    for (const child of node.children) {
      addNodes(child, positions);
      if (graph.hasNode(node.id) && graph.hasNode(child.id)) {
        graph.addDirectedEdge(node.id, child.id, {
          color: palette.edge,
          size: 1,
        });
      }
    }
  };

  return {
    update: (apiMap) => {
      palette = readDomainPalette(container);
      const tree = buildRouteTree(apiMap.routes);
      const positions = layoutRouteTree(tree);
      endpoints = new Map();
      graph.clear();
      addNodes(tree, positions);
      selectedNode = undefined;
      onSelect(undefined);
      renderer.refresh();
      void renderer.getCamera().animatedReset({ duration: 0 });
    },
    clearSelection: () => {
      selectedNode = undefined;
      onSelect(undefined);
      renderer.scheduleRefresh();
    },
    resetView: () => {
      void renderer.getCamera().animatedReset({
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 150,
      });
    },
    destroy: () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
      renderer.kill();
    },
  };
};
