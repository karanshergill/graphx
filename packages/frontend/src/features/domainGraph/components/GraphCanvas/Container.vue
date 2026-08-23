<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  createDomainGraphRenderer,
  type DomainGraphRenderer,
  type DomainGraphView,
} from "../../rendering";

const { view } = defineProps<{ view: DomainGraphView }>();
const emit = defineEmits<{
  error: [message: string];
  select: [hostname: string | undefined];
  nodecontextmenu: [payload: { hostname: string; x: number; y: number }];
  markselected: [includeSubdomains: boolean];
  drilldown: [];
}>();

const container = ref<HTMLElement>();
let renderer: DomainGraphRenderer | undefined;
let mountObserver: ResizeObserver | undefined;

const update = (): void => {
  if (renderer === undefined) return;
  renderer.update(view);
};

const mountRenderer = (): void => {
  if (renderer !== undefined) return;
  if (container.value === undefined) return;
  const { width, height } = container.value.getBoundingClientRect();
  if (width <= 0 || height <= 0) return;

  try {
    renderer = createDomainGraphRenderer(container.value, {
      onSelect: (hostname) => emit("select", hostname),
      onContextMenu: (hostname, x, y) =>
        emit("nodecontextmenu", { hostname, x, y }),
    });
    mountObserver?.disconnect();
    mountObserver = undefined;
    update();
  } catch (error: unknown) {
    mountObserver?.disconnect();
    mountObserver = undefined;
    emit("error", error instanceof Error ? error.message : String(error));
  }
};

const focusContainer = (event: PointerEvent): void => {
  const current = event.currentTarget;
  if (current instanceof HTMLElement) current.focus({ preventScroll: true });
};

const onKeydown = (event: KeyboardEvent): void => {
  if (renderer === undefined) return;

  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    renderer.selectByKeyboard("next");
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    renderer.selectByKeyboard("previous");
  } else if (event.key === "Home") {
    renderer.selectByKeyboard("first");
  } else if (event.key === "End") {
    renderer.selectByKeyboard("last");
  } else if (event.key === "Escape") {
    renderer.clearSelection();
  } else if (event.key === "0") {
    renderer.resetView();
  } else if (event.key === "m" || event.key === "M") {
    emit("markselected", event.shiftKey);
  } else if (event.key === "Enter") {
    emit("drilldown");
  } else {
    return;
  }

  event.preventDefault();
};

onMounted(() => {
  if (container.value === undefined) return;
  mountObserver = new ResizeObserver(mountRenderer);
  mountObserver.observe(container.value);
  mountRenderer();
});

watch(() => view, update);

defineExpose({
  focusNode: (hostname: string) => renderer?.focusNode(hostname),
});

onBeforeUnmount(() => {
  mountObserver?.disconnect();
  renderer?.destroy();
});
</script>

<template>
  <div
    ref="container"
    class="graphx-canvas"
    role="application"
    tabindex="0"
    aria-describedby="graphx-canvas-instructions"
    aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home End Escape 0 M Enter"
    :aria-label="`Interactive domain graph containing ${view.nodes.length} nodes`"
    @keydown="onKeydown"
    @pointerdown="focusContainer"
    @contextmenu.prevent
  />
  <p id="graphx-canvas-instructions" class="graphx-sr-only">
    Use arrow keys to select domains, Home or End to jump through the list,
    Escape to clear selection, zero to fit the graph, M to mark or unmark the
    selected domain, Shift+M to mark it with its subdomains, and Enter to open
    the selected domain's API map. Pointer users can drag nodes, pan, zoom,
    double-click to fit, and right-click the selected node for marking options.
  </p>
</template>
