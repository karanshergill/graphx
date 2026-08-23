<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const { x, y, hostname, marked, descendantCount } = defineProps<{
  x: number;
  y: number;
  hostname: string;
  marked: boolean;
  descendantCount: number;
}>();
const emit = defineEmits<{
  mark: [];
  marksubtree: [];
  unmark: [];
  unmarksubtree: [];
  close: [];
}>();

const menu = ref<HTMLElement>();
const left = ref(x);
const top = ref(y);

const clampToViewport = (): void => {
  const element = menu.value;
  if (element === undefined) return;
  const rect = element.getBoundingClientRect();
  left.value = Math.min(x, Math.max(8, window.innerWidth - rect.width - 8));
  top.value = Math.min(y, Math.max(8, window.innerHeight - rect.height - 8));
};

const onDocumentPointerDown = (event: PointerEvent): void => {
  const target = event.target;
  if (
    menu.value !== undefined &&
    target instanceof Node &&
    !menu.value.contains(target)
  ) {
    emit("close");
  }
};

const onDocumentKeydown = (event: KeyboardEvent): void => {
  if (event.key === "Escape") {
    event.stopPropagation();
    emit("close");
  }
};

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeydown, true);
  clampToViewport();
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onDocumentKeydown, true);
});

const choose = (
  action: "mark" | "marksubtree" | "unmark" | "unmarksubtree",
): void => {
  if (action === "mark") emit("mark");
  else if (action === "marksubtree") emit("marksubtree");
  else if (action === "unmark") emit("unmark");
  else emit("unmarksubtree");
  emit("close");
};
</script>

<template>
  <div
    ref="menu"
    class="graphx-context-menu"
    role="menu"
    :aria-label="`Marking options for ${hostname}`"
    :style="{ left: `${left}px`, top: `${top}px` }"
  >
    <p class="graphx-context-menu-title">{{ hostname }}</p>
    <button type="button" role="menuitem" @click="choose('mark')">
      <i class="fas fa-bookmark" aria-hidden="true" /> Mark domain
    </button>
    <button
      v-if="descendantCount > 0"
      type="button"
      role="menuitem"
      @click="choose('marksubtree')"
    >
      <i class="fas fa-sitemap" aria-hidden="true" /> Mark domain +
      {{ descendantCount }} subdomain{{ descendantCount === 1 ? "" : "s" }}
    </button>
    <button
      v-if="marked"
      type="button"
      role="menuitem"
      @click="choose('unmark')"
    >
      <i class="fas fa-times" aria-hidden="true" /> Unmark domain
    </button>
    <button
      v-if="marked && descendantCount > 0"
      type="button"
      role="menuitem"
      @click="choose('unmarksubtree')"
    >
      <i class="fas fa-times-circle" aria-hidden="true" /> Unmark domain +
      subdomains
    </button>
  </div>
</template>
