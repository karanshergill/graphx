<script setup lang="ts">
import type { ApiMapResponse, ApiRoute } from "shared";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { createRouteTreeRenderer, type RouteTreeRenderer } from "./renderer";

const { apiMap, host } = defineProps<{
  apiMap: ApiMapResponse;
  host: string;
}>();
const emit = defineEmits<{
  select: [endpoint: ApiRoute | undefined];
  back: [];
  error: [message: string];
}>();

const container = ref<HTMLElement>();
let renderer: RouteTreeRenderer | undefined;
let mountObserver: ResizeObserver | undefined;

const mountRenderer = (): void => {
  if (renderer !== undefined || container.value === undefined) return;
  const { width, height } = container.value.getBoundingClientRect();
  if (width <= 0 || height <= 0) return;
  try {
    renderer = createRouteTreeRenderer(container.value, (endpoint) =>
      emit("select", endpoint),
    );
    mountObserver?.disconnect();
    mountObserver = undefined;
    renderer.update(apiMap);
  } catch (error: unknown) {
    mountObserver?.disconnect();
    mountObserver = undefined;
    emit("error", error instanceof Error ? error.message : String(error));
  }
};

const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === "Escape") {
    if (renderer !== undefined) renderer.clearSelection();
    emit("back");
    event.preventDefault();
  } else if (event.key === "0") {
    renderer?.resetView();
    event.preventDefault();
  }
};

onMounted(() => {
  if (container.value === undefined) return;
  mountObserver = new ResizeObserver(mountRenderer);
  mountObserver.observe(container.value);
  mountRenderer();
});

watch(
  () => apiMap,
  () => renderer?.update(apiMap),
);

onBeforeUnmount(() => {
  mountObserver?.disconnect();
  renderer?.destroy();
});
</script>

<template>
  <div
    ref="container"
    class="graphx-canvas graphx-route-canvas"
    role="application"
    tabindex="0"
    :aria-label="`API route map for ${host}`"
    aria-keyshortcuts="Escape 0"
    @keydown="onKeydown"
  />
</template>
