<script setup lang="ts">
import type { ApiRoute } from "shared";
import { computed, nextTick, ref, watch } from "vue";

import { indexRouteSearch, searchRouteIndex } from "./routeSearch";

const { routes, disabled = false } = defineProps<{
  routes: readonly ApiRoute[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ jump: [template: string] }>();
const query = ref("");
const open = ref(false);
const highlighted = ref(0);
const input = ref<HTMLInputElement>();
const results = ref<HTMLUListElement>();
const index = computed(() => indexRouteSearch(routes));
const matches = computed(() => searchRouteIndex(index.value, query.value));

watch(query, (value) => {
  highlighted.value = 0;
  open.value = value.trim().length > 0;
});
watch([() => routes, () => disabled], () => {
  highlighted.value = 0;
  open.value = false;
});
watch(highlighted, async () => {
  await nextTick();
  results.value?.children
    .item(highlighted.value)
    ?.scrollIntoView({ block: "nearest" });
});

const pick = (template: string): void => {
  open.value = false;
  highlighted.value = 0;
  emit("jump", template);
};
const clear = (): void => {
  query.value = "";
  open.value = false;
  highlighted.value = 0;
  input.value?.focus();
};
const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    open.value = query.value.trim().length > 0;
    highlighted.value = Math.max(
      0,
      Math.min(
        highlighted.value + (event.key === "ArrowDown" ? 1 : -1),
        matches.value.length - 1,
      ),
    );
  } else if (event.key === "Enter") {
    const route = matches.value[highlighted.value];
    if (route !== undefined) pick(route.template);
  } else if (event.key === "Escape") {
    query.value = "";
    open.value = false;
    input.value?.blur();
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
};

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="graphx-search graphx-route-search">
    <i class="fas fa-search" aria-hidden="true" />
    <input
      ref="input"
      v-model="query"
      type="text"
      role="combobox"
      placeholder="Search routes…  ( / )"
      aria-label="Search route templates and example paths"
      aria-autocomplete="list"
      aria-controls="graphx-route-search-results"
      :aria-expanded="open"
      :aria-activedescendant="
        open && matches.length > 0
          ? `graphx-route-search-option-${highlighted}`
          : undefined
      "
      :disabled="disabled"
      @keydown="onKeydown"
      @focus="open = query.trim().length > 0"
      @blur="open = false"
    />
    <span v-if="query.trim().length > 0" class="graphx-search-count">
      {{ matches.length }} shown
    </span>
    <button
      v-if="query.length > 0"
      type="button"
      class="graphx-search-clear"
      aria-label="Clear route search"
      :disabled="disabled"
      @mousedown.prevent
      @click="clear"
    >
      <i class="fas fa-times" aria-hidden="true" />
    </button>
    <ul
      v-if="open && matches.length > 0"
      id="graphx-route-search-results"
      ref="results"
      class="graphx-search-results"
      role="listbox"
      aria-label="Matching routes"
    >
      <li
        v-for="(route, at) in matches"
        :id="`graphx-route-search-option-${at}`"
        :key="route.template"
        role="option"
        :title="`${route.template} — ${route.examplePath}`"
        :aria-selected="at === highlighted"
        :class="{ 'graphx-search-active': at === highlighted }"
        @mousedown.prevent="pick(route.template)"
        @mouseenter="highlighted = at"
      >
        <span>{{ route.template }}</span>
        <small v-if="route.examplePath !== route.template">{{
          route.examplePath
        }}</small>
      </li>
    </ul>
    <div v-else-if="open" class="graphx-search-results" role="status">
      No matching routes
    </div>
  </div>
</template>
