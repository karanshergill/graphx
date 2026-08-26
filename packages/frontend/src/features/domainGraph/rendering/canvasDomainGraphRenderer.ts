import FA2Layout from "graphology-layout-forceatlas2/worker";

import type { DomainConnectionPath } from "../marking";

import {
  createRendererGraph,
  type DomainGraphAssets,
  type DomainGraphView,
  readDomainPalette,
  type RendererEdgeAttributes,
  type RendererNodeAttributes,
  updateRendererGraph,
} from "./domainGraphModel";
import type {
  DomainGraphRenderer,
  DomainGraphRendererCallbacks,
} from "./domainGraphRenderer";

type Point = {
  x: number;
  y: number;
};

type Camera = {
  x: number;
  y: number;
  scale: number;
};

type DragState =
  | {
      kind: "node";
      node: string;
    }
  | {
      kind: "pan";
      pointer: Point;
      camera: Point;
    };

const LAYOUT_DURATION_MS = 2_400;
const MIN_SCALE = 0.2;
const MAX_SCALE = 2_000;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const createCanvasDomainGraphRenderer = (
  container: HTMLElement,
  callbacks: DomainGraphRendererCallbacks,
): DomainGraphRenderer => {
  const { onSelect, onContextMenu } = callbacks;
  const graph = createRendererGraph();
  const canvas = document.createElement("canvas");
  canvas.className = "graphx-canvas-2d";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    height: "100%",
    inset: "0",
    position: "absolute",
    touchAction: "none",
    width: "100%",
  });
  container.append(canvas);

  const context = canvas.getContext("2d", { alpha: true });
  if (context === null) {
    canvas.remove();
    throw new Error("GraphX could not create a Canvas 2D rendering context.");
  }

  let palette = readDomainPalette(container);
  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let autoFit = true;
  let selectedNode: string | undefined;
  let hoveredNode: string | undefined;
  let connectionPath: DomainConnectionPath | undefined;
  let assetsView: DomainGraphAssets | undefined;
  let prominentHosts: ReadonlySet<string> | undefined;
  let dragState: DragState | undefined;
  let layout:
    FA2Layout<RendererNodeAttributes, RendererEdgeAttributes> | undefined;
  let layoutTimer: number | undefined;
  let renderFrame: number | undefined;

  const pointerPosition = (event: MouseEvent): Point => {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
  };

  const graphToScreen = (point: Point): Point => ({
    x: (point.x - camera.x) * camera.scale + width / 2,
    y: (point.y - camera.y) * camera.scale + height / 2,
  });

  const screenToGraph = (point: Point): Point => ({
    x: camera.x + (point.x - width / 2) / camera.scale,
    y: camera.y + (point.y - height / 2) / camera.scale,
  });

  const fitGraph = (): void => {
    if (graph.order === 0) {
      camera = { x: 0, y: 0, scale: 1 };
      return;
    }

    let minimumX = Number.POSITIVE_INFINITY;
    let maximumX = Number.NEGATIVE_INFINITY;
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    graph.forEachNode((_node, attributes) => {
      minimumX = Math.min(minimumX, attributes.x);
      maximumX = Math.max(maximumX, attributes.x);
      minimumY = Math.min(minimumY, attributes.y);
      maximumY = Math.max(maximumY, attributes.y);
    });

    const horizontalRange = Math.max(1, maximumX - minimumX);
    const verticalRange = Math.max(1, maximumY - minimumY);
    const horizontalSpace = Math.max(1, width - 128);
    const verticalSpace = Math.max(1, height - 128);
    camera = {
      x: (minimumX + maximumX) / 2,
      y: (minimumY + maximumY) / 2,
      scale: clamp(
        Math.min(
          horizontalSpace / horizontalRange,
          verticalSpace / verticalRange,
        ),
        MIN_SCALE,
        MAX_SCALE,
      ),
    };
  };

  const focusedNodes = (): Set<string> => {
    const focus = hoveredNode ?? selectedNode;
    if (focus === undefined || !graph.hasNode(focus)) return new Set<string>();
    return new Set([focus, ...graph.neighbors(focus)]);
  };

  const draw = (): void => {
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const focus = hoveredNode ?? selectedNode;
    const focusSet = focusedNodes();
    context.lineCap = "round";
    graph.forEachEdge((edge, attributes, source, target) => {
      const sourceAttributes = graph.getNodeAttributes(source);
      const targetAttributes = graph.getNodeAttributes(target);
      const from = graphToScreen(sourceAttributes);
      const to = graphToScreen(targetAttributes);
      let color = palette.edge;
      let width = attributes.size;
      if (focus !== undefined) {
        const emphasized = source === focus || target === focus;
        color = emphasized ? palette.neighbor : palette.mutedEdge;
        width = emphasized ? 1.8 : attributes.size;
      } else if (connectionPath !== undefined) {
        const onPath = connectionPath.relationships.has(edge);
        color = onPath ? palette.path : palette.mutedEdge;
        width = onPath ? 1.8 : attributes.size;
      } else if (prominentHosts !== undefined) {
        const prominent =
          prominentHosts.has(sourceAttributes.hostname) &&
          prominentHosts.has(targetAttributes.hostname);
        if (!prominent) color = palette.mutedEdge;
      }
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.strokeStyle = color;
      context.lineWidth = width;
      context.stroke();
    });

    graph.forEachNode((node, attributes) => {
      const point = graphToScreen(attributes);
      const isFocus = node === focus;
      const isNeighbor = !isFocus && focusSet.has(node);
      const assetsActive =
        assetsView?.active === true &&
        connectionPath === undefined &&
        prominentHosts === undefined;
      const hostAssets =
        assetsView?.active === true && connectionPath === undefined
          ? assetsView.byHost.get(attributes.hostname)
          : undefined;
      const offAssets =
        assetsActive === true &&
        (hostAssets === undefined || hostAssets.bundleCount === 0);
      const offProminent =
        prominentHosts !== undefined &&
        connectionPath === undefined &&
        !prominentHosts.has(attributes.hostname);
      const baseColor = attributes.marked
        ? palette.marked
        : attributes.root
          ? palette.root
          : attributes.observed
            ? palette.observed
            : palette.structural;
      let color = baseColor;
      if (focus !== undefined) {
        color = isFocus
          ? palette.selected
          : isNeighbor
            ? palette.neighbor
            : palette.mutedNode;
      } else if (
        connectionPath !== undefined &&
        !connectionPath.nodes.has(node)
      ) {
        color = palette.mutedNode;
      } else if (offProminent) {
        color = palette.mutedNode;
      } else if (offAssets) {
        color = palette.mutedNode;
      }
      const radius = attributes.size + (isFocus ? 3 : 0);

      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();

      const offPath =
        connectionPath !== undefined &&
        focus === undefined &&
        !connectionPath.nodes.has(node);
      const labelTooSmall = 11 * camera.scale < 7 && !isFocus;
      const labelText =
        hostAssets !== undefined && hostAssets.bundleCount > 0
          ? `${attributes.hostname} · ${hostAssets.bundleCount}`
          : attributes.label;
      if (
        (attributes.root || isFocus || isNeighbor) &&
        !labelTooSmall &&
        !offPath &&
        !(offAssets && focus === undefined) &&
        !(offProminent && focus === undefined)
      ) {
        context.font = `${attributes.root || isFocus ? 600 : 400} 11px system-ui, sans-serif`;
        context.textBaseline = "middle";
        const labelX = point.x + radius + 5;
        const isHovered = node === hoveredNode;
        if (isHovered) {
          const labelWidth = context.measureText(labelText).width;
          context.fillStyle = palette.neighbor;
          context.beginPath();
          if (typeof context.roundRect === "function") {
            context.roundRect(labelX - 4, point.y - 9, labelWidth + 8, 18, 3);
          } else {
            context.rect(labelX - 4, point.y - 9, labelWidth + 8, 18);
          }
          context.fill();
        }
        context.fillStyle = isHovered ? palette.onNeighbor : palette.label;
        context.fillText(labelText, labelX, point.y);
      }
    });
  };

  const stopLayout = (): void => {
    if (layoutTimer !== undefined) window.clearTimeout(layoutTimer);
    if (renderFrame !== undefined) window.cancelAnimationFrame(renderFrame);
    layoutTimer = undefined;
    renderFrame = undefined;
    layout?.kill();
    layout = undefined;
  };

  const renderLayoutFrame = (): void => {
    if (layout === undefined) return;
    if (autoFit) fitGraph();
    draw();
    renderFrame = window.requestAnimationFrame(renderLayoutFrame);
  };

  const startLayout = (): void => {
    stopLayout();
    if (graph.order < 2 || graph.size === 0) {
      if (autoFit) fitGraph();
      draw();
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (autoFit) fitGraph();
      draw();
      return;
    }

    try {
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
      renderLayoutFrame();
      layoutTimer = window.setTimeout(() => {
        stopLayout();
        if (autoFit) fitGraph();
        draw();
      }, LAYOUT_DURATION_MS);
    } catch {
      layout = undefined;
      if (autoFit) fitGraph();
      draw();
    }
  };

  const resize = (): void => {
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    if (autoFit) fitGraph();
    draw();
  };

  const findNode = (point: Point): string | undefined => {
    let match: string | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    graph.forEachNode((node, attributes) => {
      const screen = graphToScreen(attributes);
      const distance = Math.hypot(screen.x - point.x, screen.y - point.y);
      const hitRadius = attributes.size + 7;
      if (distance <= hitRadius && distance < nearestDistance) {
        match = node;
        nearestDistance = distance;
      }
    });
    return match;
  };

  const onContextMenuEvent = (event: MouseEvent): void => {
    event.preventDefault();
    const node = findNode(pointerPosition(event));
    if (node !== undefined && node === selectedNode) {
      onContextMenu(
        graph.getNodeAttribute(node, "hostname"),
        event.clientX,
        event.clientY,
      );
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    stopLayout();
    autoFit = false;
    const pointer = pointerPosition(event);
    const node = findNode(pointer);
    if (node !== undefined) {
      selectedNode = node;
      dragState = { kind: "node", node };
      onSelect(graph.getNodeAttribute(node, "hostname"));
    } else {
      selectedNode = undefined;
      dragState = {
        kind: "pan",
        pointer,
        camera: { x: camera.x, y: camera.y },
      };
      onSelect(undefined);
    }
    draw();
  };

  const onPointerMove = (event: PointerEvent): void => {
    const pointer = pointerPosition(event);
    if (dragState?.kind === "node") {
      const position = screenToGraph(pointer);
      graph.setNodeAttribute(dragState.node, "x", position.x);
      graph.setNodeAttribute(dragState.node, "y", position.y);
      draw();
      return;
    }
    if (dragState?.kind === "pan") {
      camera.x =
        dragState.camera.x - (pointer.x - dragState.pointer.x) / camera.scale;
      camera.y =
        dragState.camera.y - (pointer.y - dragState.pointer.y) / camera.scale;
      draw();
      return;
    }

    const nextHoveredNode = findNode(pointer);
    if (nextHoveredNode !== hoveredNode) {
      hoveredNode = nextHoveredNode;
      canvas.style.cursor = hoveredNode === undefined ? "grab" : "pointer";
      draw();
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    dragState = undefined;
  };

  const onPointerLeave = (): void => {
    if (dragState !== undefined || hoveredNode === undefined) return;
    hoveredNode = undefined;
    canvas.style.cursor = "grab";
    draw();
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    stopLayout();
    autoFit = false;
    const pointer = pointerPosition(event);
    const graphPoint = screenToGraph(pointer);
    const scale = clamp(
      camera.scale * Math.exp(-event.deltaY * 0.001),
      MIN_SCALE,
      MAX_SCALE,
    );
    camera = {
      x: graphPoint.x - (pointer.x - width / 2) / scale,
      y: graphPoint.y - (pointer.y - height / 2) / scale,
      scale,
    };
    draw();
  };

  const onDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    autoFit = true;
    fitGraph();
    draw();
  };

  const applyTheme = (): void => {
    palette = readDomainPalette(container);
    draw();
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
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

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("contextmenu", onContextMenuEvent);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);
  resize();

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
    if (hoveredNode !== undefined && !graph.hasNode(hoveredNode)) {
      hoveredNode = undefined;
      canvas.style.cursor = "grab";
    }
    if (autoFit) fitGraph();
    draw();
    if (topologyChanged) {
      stopLayout();
      startLayout();
    }
  };

  const clearSelection = (): void => {
    selectedNode = undefined;
    hoveredNode = undefined;
    onSelect(undefined);
    draw();
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
    if (selectedNode === undefined) return;

    const attributes = graph.getNodeAttributes(selectedNode);
    camera.x = attributes.x;
    camera.y = attributes.y;
    autoFit = false;
    onSelect(attributes.hostname);
    draw();
  };

  const focusNode = (hostname: string): void => {
    const node = `domain:${hostname}`;
    if (!graph.hasNode(node)) return;
    const attributes = graph.getNodeAttributes(node);
    selectedNode = node;
    hoveredNode = undefined;
    camera.x = attributes.x;
    camera.y = attributes.y;
    autoFit = false;
    onSelect(hostname);
    draw();
  };

  const resetView = (): void => {
    autoFit = true;
    fitGraph();
    draw();
  };

  const destroy = (): void => {
    stopLayout();
    resizeObserver.disconnect();
    themeObserver.disconnect();
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("contextmenu", onContextMenuEvent);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("dblclick", onDoubleClick);
    canvas.remove();
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
