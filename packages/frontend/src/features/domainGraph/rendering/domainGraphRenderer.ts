import FA2Layout from "graphology-layout-forceatlas2/worker";
import SigmaRenderer from "sigma";

import type { DomainConnectionPath } from "../marking";

import {
  createHoverLabelDrawer,
  createRendererGraph,
  type DomainGraphAssets,
  type DomainGraphView,
  readDomainPalette,
  type RendererEdgeAttributes,
  type RendererNodeAttributes,
  updateRendererGraph,
} from "./domainGraphModel";

export type DomainGraphRendererCallbacks = {
  onSelect: (hostname: string | undefined) => void;
  onContextMenu: (hostname: string, x: number, y: number) => void;
};

export type DomainGraphRenderer = {
  update: (view: DomainGraphView) => void;
  clearSelection: () => void;
  destroy: () => void;
  focusNode: (hostname: string) => void;
  resetView: () => void;
  selectByKeyboard: (direction: "first" | "last" | "next" | "previous") => void;
};

export const createSigmaDomainGraphRenderer = (
  container: HTMLElement,
  callbacks: DomainGraphRendererCallbacks,
): DomainGraphRenderer => {
  const { onSelect, onContextMenu } = callbacks;
  const graph = createRendererGraph();
  let palette = readDomainPalette(container);
  let selectedNode: string | undefined;
  let hoveredNode: string | undefined;
  let connectionPath: DomainConnectionPath | undefined;
  let assetsView: DomainGraphAssets | undefined;
  let prominentHosts: ReadonlySet<string> | undefined;
  let layout:
    FA2Layout<RendererNodeAttributes, RendererEdgeAttributes> | undefined;
  let layoutTimer: number | undefined;

  const renderer = new SigmaRenderer(graph, container, {
    defaultDrawNodeHover: createHoverLabelDrawer(() => palette),
    hideEdgesOnMove: false,
    hideLabelsOnMove: false,
    labelColor: { color: palette.label },
    labelDensity: 0.8,
    labelFont: "system-ui, sans-serif",
    labelGridCellSize: 120,
    labelRenderedSizeThreshold: 7,
    minCameraRatio: 0.03,
    maxCameraRatio: 12,
    renderEdgeLabels: false,
    stagePadding: 48,
    zIndex: true,
  });

  let focusSetCache: Set<string> | undefined;
  const focusedNodes = (): Set<string> => {
    if (focusSetCache !== undefined) return focusSetCache;
    const focus = hoveredNode ?? selectedNode;
    focusSetCache =
      focus === undefined || !graph.hasNode(focus)
        ? new Set<string>()
        : new Set([focus, ...graph.neighbors(focus)]);
    return focusSetCache;
  };
  const invalidateFocusSet = (): void => {
    focusSetCache = undefined;
  };

  renderer.setSetting("nodeReducer", (node, data) => {
    const focus = hoveredNode ?? selectedNode;
    if (focus !== undefined) {
      if (node === focus) {
        return {
          ...data,
          color: palette.selected,
          highlighted: true,
          size: data.size + 3,
          zIndex: 3,
        };
      }
      if (focusedNodes().has(node)) {
        return { ...data, color: palette.neighbor, zIndex: 2 };
      }
      return { ...data, color: palette.mutedNode, label: null, zIndex: 0 };
    }
    if (connectionPath !== undefined && !connectionPath.nodes.has(node)) {
      return { ...data, color: palette.mutedNode, label: null, zIndex: 0 };
    }
    if (connectionPath === undefined && prominentHosts !== undefined) {
      const host = graph.getNodeAttribute(node, "hostname");
      if (!prominentHosts.has(host)) {
        return { ...data, color: palette.mutedNode, label: null, zIndex: 0 };
      }
      const hostAssets = assetsView?.byHost.get(host);
      if (hostAssets !== undefined && hostAssets.bundleCount > 0) {
        return { ...data, label: `${host} · ${hostAssets.bundleCount}` };
      }
      return data;
    }
    if (connectionPath === undefined && assetsView?.active === true) {
      const host = graph.getNodeAttribute(node, "hostname");
      const hostAssets = assetsView.byHost.get(host);
      if (hostAssets === undefined || hostAssets.bundleCount === 0) {
        return { ...data, color: palette.mutedNode, label: null, zIndex: 0 };
      }
      return { ...data, label: `${host} · ${hostAssets.bundleCount}` };
    }
    return data;
  });

  renderer.setSetting("edgeReducer", (edge, data) => {
    const focus = hoveredNode ?? selectedNode;
    if (focus !== undefined) {
      const [source, target] = graph.extremities(edge);
      return source === focus || target === focus
        ? { ...data, color: palette.neighbor, size: 1.8, zIndex: 2 }
        : { ...data, color: palette.mutedEdge, size: 0.5, zIndex: 0 };
    }
    if (connectionPath !== undefined) {
      return connectionPath.relationships.has(edge)
        ? { ...data, color: palette.path, size: 1.8, zIndex: 2 }
        : { ...data, color: palette.mutedEdge, size: 0.5, zIndex: 0 };
    }
    if (prominentHosts !== undefined) {
      const [source, target] = graph.extremities(edge);
      const prominent =
        prominentHosts.has(graph.getNodeAttribute(source, "hostname")) &&
        prominentHosts.has(graph.getNodeAttribute(target, "hostname"));
      return prominent
        ? data
        : { ...data, color: palette.mutedEdge, size: 0.5, zIndex: 0 };
    }
    return data;
  });

  const stopLayout = (): void => {
    if (layoutTimer !== undefined) window.clearTimeout(layoutTimer);
    layoutTimer = undefined;
    if (layout !== undefined) layout.kill();
    layout = undefined;
  };

  const startLayout = (): void => {
    stopLayout();
    if (graph.order < 2 || graph.size === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      renderer.refresh();
      return;
    }
    layout = new FA2Layout(graph, {
      settings: {
        adjustSizes: true,
        barnesHutOptimize: graph.order >= 100,
        edgeWeightInfluence: 1,
        gravity: 1,
        scalingRatio: 5,
        slowDown: 4,
        strongGravityMode: true,
      },
    });
    layout.start();
    layoutTimer = window.setTimeout(() => {
      layout?.kill();
      layout = undefined;
      layoutTimer = undefined;
    }, 2_400);
  };

  const applyTheme = (): void => {
    palette = readDomainPalette(container);
    renderer.setSetting("labelColor", { color: palette.label });
    graph.updateEachNodeAttributes((_node, attributes) => ({
      ...attributes,
      color: attributes.marked
        ? palette.marked
        : attributes.root
          ? palette.root
          : attributes.observed
            ? palette.observed
            : palette.structural,
    }));
    graph.updateEachEdgeAttributes((_edge, attributes) => ({
      ...attributes,
      color: palette.edge,
    }));
    renderer.scheduleRefresh();
  };

  const resizeObserver = new ResizeObserver(() => renderer.resize());
  resizeObserver.observe(container);

  const themeObserver = new MutationObserver(() => applyTheme());
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

  renderer.on("clickNode", ({ node }) => {
    selectedNode = node;
    invalidateFocusSet();
    onSelect(graph.getNodeAttribute(node, "hostname"));
    renderer.scheduleRefresh();
  });
  renderer.on("clickStage", () => {
    selectedNode = undefined;
    invalidateFocusSet();
    onSelect(undefined);
    renderer.scheduleRefresh();
  });
  renderer.on("enterNode", ({ node }) => {
    hoveredNode = node;
    invalidateFocusSet();
    renderer.scheduleRefresh();
  });
  renderer.on("leaveNode", () => {
    hoveredNode = undefined;
    invalidateFocusSet();
    renderer.scheduleRefresh();
  });
  renderer.on("rightClickNode", ({ event, node }) => {
    event.preventSigmaDefault();
    if (node !== selectedNode) return;
    const bounds = container.getBoundingClientRect();
    onContextMenu(
      graph.getNodeAttribute(node, "hostname"),
      bounds.left + event.x,
      bounds.top + event.y,
    );
  });
  renderer.on("doubleClickStage", ({ preventSigmaDefault }) => {
    preventSigmaDefault();
    resetView();
  });

  let draggedNode: string | undefined;
  renderer.on("downNode", ({ event, node }) => {
    if (event.original instanceof MouseEvent && event.original.button !== 0)
      return;
    stopLayout();
    draggedNode = node;
    graph.setNodeAttribute(node, "highlighted", true);
    event.preventSigmaDefault();
    renderer.getCamera().disable();
  });
  renderer.getMouseCaptor().on("mousemovebody", (event) => {
    if (draggedNode === undefined) return;
    const position = renderer.viewportToGraph(event);
    graph.setNodeAttribute(draggedNode, "x", position.x);
    graph.setNodeAttribute(draggedNode, "y", position.y);
  });
  renderer.getMouseCaptor().on("mouseup", () => {
    if (draggedNode !== undefined && graph.hasNode(draggedNode)) {
      graph.setNodeAttribute(draggedNode, "highlighted", false);
    }
    draggedNode = undefined;
    renderer.getCamera().enable();
  });
  renderer.getMouseCaptor().on("mousedown", () => {
    if (renderer.getCustomBBox() === null) {
      renderer.setCustomBBox(renderer.getBBox());
    }
  });

  const update = (view: DomainGraphView): void => {
    palette = readDomainPalette(container);
    connectionPath = view.connectionPath;
    assetsView = view.assets;
    prominentHosts = view.prominentHosts;
    const nodesBefore = new Set(graph.nodes());
    const edgesBefore = new Set(graph.edges());
    updateRendererGraph(graph, view, palette);
    const topologyChanged =
      nodesBefore.size !== graph.order ||
      edgesBefore.size !== graph.size ||
      [...nodesBefore].some((node) => !graph.hasNode(node)) ||
      [...edgesBefore].some((edge) => !graph.hasEdge(edge));

    if (selectedNode !== undefined && !graph.hasNode(selectedNode)) {
      selectedNode = undefined;
      onSelect(undefined);
    }
    invalidateFocusSet();
    renderer.refresh();
    if (topologyChanged) {
      stopLayout();
      startLayout();
    }
  };

  const clearSelection = (): void => {
    selectedNode = undefined;
    hoveredNode = undefined;
    invalidateFocusSet();
    onSelect(undefined);
    renderer.scheduleRefresh();
  };

  const selectByKeyboard = (
    direction: "first" | "last" | "next" | "previous",
  ): void => {
    const nodes = graph.nodes();
    if (nodes.length === 0) {
      clearSelection();
      return;
    }

    const currentIndex =
      selectedNode === undefined ? -1 : nodes.indexOf(selectedNode);
    const nextIndex =
      direction === "first"
        ? 0
        : direction === "last"
          ? nodes.length - 1
          : direction === "previous"
            ? (currentIndex <= 0 ? nodes.length : currentIndex) - 1
            : (currentIndex + 1) % nodes.length;
    selectedNode = nodes[nextIndex];
    hoveredNode = undefined;
    invalidateFocusSet();
    if (selectedNode === undefined) return;

    onSelect(graph.getNodeAttribute(selectedNode, "hostname"));
    const displayData = renderer.getNodeDisplayData(selectedNode);
    if (displayData !== undefined) {
      renderer.getCamera().setState({ x: displayData.x, y: displayData.y });
    }
    renderer.scheduleRefresh();
  };

  const focusNode = (hostname: string): void => {
    const node = `domain:${hostname}`;
    if (!graph.hasNode(node)) return;
    selectedNode = node;
    hoveredNode = undefined;
    invalidateFocusSet();
    onSelect(hostname);
    const displayData = renderer.getNodeDisplayData(node);
    if (displayData !== undefined) {
      renderer.getCamera().setState({ x: displayData.x, y: displayData.y });
    }
    renderer.scheduleRefresh();
  };

  const resetView = (): void => {
    void renderer.getCamera().animatedReset({
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 0
        : 150,
    });
  };

  const destroy = (): void => {
    stopLayout();
    resizeObserver.disconnect();
    themeObserver.disconnect();
    renderer.kill();
  };

  return {
    clearSelection,
    destroy,
    focusNode,
    resetView,
    selectByKeyboard,
    update,
  };
};
