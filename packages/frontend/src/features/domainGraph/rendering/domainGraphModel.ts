import { DirectedGraph } from "graphology";
import type { DomainGraphProjection, DomainNode } from "shared";

import type { HostAssets } from "../assets";
import type { DomainConnectionPath } from "../marking";

export type DomainGraphAssets = {
  byHost: ReadonlyMap<string, HostAssets>;
  active: boolean;
};

export type DomainGraphView = DomainGraphProjection & {
  marks: ReadonlySet<string>;
  connectionPath?: DomainConnectionPath;
  assets?: DomainGraphAssets;
  prominentHosts?: ReadonlySet<string>;
};

export type RendererNodeAttributes = {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  forceLabel: boolean;
  zIndex: number;
  highlighted: boolean;
  hostname: string;
  observed: boolean;
  root: boolean;
  marked: boolean;
};

export type RendererEdgeAttributes = {
  size: number;
  color: string;
  label: string;
};

export type DomainPalette = {
  root: string;
  observed: string;
  structural: string;
  edge: string;
  label: string;
  selected: string;
  neighbor: string;
  onNeighbor: string;
  marked: string;
  path: string;
  danger: string;
  mutedNode: string;
  mutedEdge: string;
};

type RendererGraph = DirectedGraph<
  RendererNodeAttributes,
  RendererEdgeAttributes
>;

const stableHash = (value: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

const cssColor = (
  probe: HTMLElement,
  property: string,
  fallback: string,
): string => {
  // Reading the custom property directly returns the raw var() token stream
  // unsubstituted; resolving through a real property yields a used color.
  probe.style.color = `var(${property}, ${fallback})`;
  return window.getComputedStyle(probe).color || fallback;
};

const positionFor = (node: DomainNode): { x: number; y: number } => {
  const hash = stableHash(node.hostname);
  const angle = (hash / 4_294_967_295) * Math.PI * 2;
  const jitter = ((hash >>> 8) % 100) / 100;
  const radius = 1 + node.depth * 1.6 + jitter;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
};

const nodeColor = (
  node: DomainNode,
  palette: DomainPalette,
  marked: boolean,
): string => {
  if (marked) return palette.marked;
  if (node.depth === 0) return palette.root;
  return node.observed ? palette.observed : palette.structural;
};

export const readDomainPalette = (container: HTMLElement): DomainPalette => {
  const probe = document.createElement("span");
  probe.style.display = "none";
  container.append(probe);
  try {
    return {
      root: cssColor(probe, "--graphx-root-node", "#38bdf8"),
      observed: cssColor(probe, "--graphx-observed-node", "#818cf8"),
      structural: cssColor(probe, "--graphx-structural-node", "#64748b"),
      edge: cssColor(probe, "--graphx-edge", "#475569"),
      label: cssColor(probe, "--p-text-color", "#e2e8f0"),
      selected: cssColor(probe, "--graphx-selected-node", "#f8fafc"),
      neighbor: cssColor(probe, "--graphx-neighbor-node", "#22d3ee"),
      onNeighbor: cssColor(probe, "--graphx-on-neighbor-node", "#0f172a"),
      marked: cssColor(probe, "--graphx-marked-node", "#4ade80"),
      path: cssColor(probe, "--graphx-path-edge", "#67e8f9"),
      danger: cssColor(probe, "--graphx-danger-node", "#f58e97"),
      mutedNode: cssColor(probe, "--graphx-muted-node", "#334155"),
      mutedEdge: cssColor(probe, "--graphx-muted-edge", "#1e293b"),
    };
  } finally {
    probe.remove();
  }
};

export const createHoverLabelDrawer =
  (readPalette: () => DomainPalette) =>
  (
    context: CanvasRenderingContext2D,
    data: { x: number; y: number; size: number; label: unknown },
    settings: { labelSize: number; labelFont: string; labelWeight: string },
  ): void => {
    if (typeof data.label !== "string" || data.label.length === 0) return;
    const palette = readPalette();
    const size = settings.labelSize;
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    const horizontalPadding = 4;
    const boxHeight = size + 6;
    const left = data.x + data.size + 3;
    const top = data.y - boxHeight / 2;
    const width = context.measureText(data.label).width + horizontalPadding * 2;
    context.fillStyle = palette.neighbor;
    context.beginPath();
    if (typeof context.roundRect === "function") {
      context.roundRect(left - horizontalPadding, top, width, boxHeight, 3);
    } else {
      context.rect(left - horizontalPadding, top, width, boxHeight);
    }
    context.fill();
    context.fillStyle = palette.onNeighbor;
    context.fillText(data.label, left, data.y + size / 3);
  };

export const createRendererGraph = (): RendererGraph =>
  new DirectedGraph<RendererNodeAttributes, RendererEdgeAttributes>();

export const updateRendererGraph = (
  graph: RendererGraph,
  view: DomainGraphView,
  palette: DomainPalette,
): void => {
  const positions = new Map<string, { x: number; y: number }>(
    graph.mapNodes(
      (node, attributes) =>
        [node, { x: attributes.x, y: attributes.y }] as const,
    ),
  );
  graph.clear();

  for (const node of view.nodes) {
    const position = positions.get(node.id) ?? positionFor(node);
    const marked = view.marks.has(node.hostname);
    graph.addNode(node.id, {
      ...position,
      color: nodeColor(node, palette, marked),
      forceLabel: node.depth === 0,
      highlighted: false,
      hostname: node.hostname,
      label: node.label,
      marked,
      observed: node.observed,
      root: node.depth === 0,
      size: node.depth === 0 ? 11 : node.observed ? 7 : 4.5,
      zIndex: node.depth === 0 ? 2 : node.observed ? 1 : 0,
    });
  }

  for (const relationship of view.relationships) {
    graph.addDirectedEdgeWithKey(
      relationship.id,
      relationship.source,
      relationship.target,
      {
        color: palette.edge,
        label: "parent domain",
        size: 1,
      },
    );
  }
};
