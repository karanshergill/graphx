<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { rankDomainMatches } from "../../search";

const { hostnames } = defineProps<{ hostnames: readonly string[] }>();
const emit = defineEmits<{
  jump: [hostname: string];
}>();

const query = ref("");
const open = ref(false);
const highlighted = ref(0);
const input = ref<HTMLInputElement>();

const matches = computed(() => rankDomainMatches(hostnames, query.value));

watch(query, (value) => {
  highlighted.value = 0;
  open.value = value.trim().length > 0;
});

const pick = (hostname: string): void => {
  emit("jump", hostname);
  open.value = false;
  highlighted.value = 0;
};

const clear = (): void => {
  query.value = "";
  open.value = false;
  highlighted.value = 0;
  input.value?.focus();
};

const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === "ArrowDown") {
    highlighted.value = Math.min(
      highlighted.value + 1,
      matches.value.length - 1,
    );
    event.preventDefault();
  } else if (event.key === "ArrowUp") {
    highlighted.value = Math.max(highlighted.value - 1, 0);
    event.preventDefault();
  } else if (event.key === "Enter") {
    const target = matches.value[highlighted.value] ?? matches.value[0];
    if (target !== undefined) pick(target);
    event.preventDefault();
  } else if (event.key === "Escape") {
    if (query.value.length > 0) {
      query.value = "";
      open.value = false;
    }
    input.value?.blur();
    event.preventDefault();
  }
};

defineExpose({
  focus: () => input.value?.focus(),
});
</script>

<template>
  <div class="graphx-search">
    <i class="fas fa-search" aria-hidden="true" />
    <input
      ref="input"
      v-model="query"
      type="text"
      placeholder="Search domains…  ( / )"
      aria-label="Search domains and subdomains"
      :aria-expanded="open"
      @keydown="onKeydown"
      @focus="open = query.trim().length > 0"
      @blur="open = false"
    />
    <span v-if="query.trim().length > 0" class="graphx-search-count">
      {{ matches.length }} match{{ matches.length === 1 ? "" : "es" }}
    </span>
    <button
      v-if="query.length > 0"
      type="button"
      class="graphx-search-clear"
      aria-label="Clear search"
      @mousedown.prevent="clear"
    >
      <i class="fas fa-times" aria-hidden="true" />
    </button>
    <ul
      v-if="open && matches.length > 0"
      class="graphx-search-results"
      role="listbox"
      aria-label="Matching domains"
    >
      <li
        v-for="(hostname, index) in matches"
        :key="hostname"
        role="option"
        :title="hostname"
        :aria-selected="index === highlighted"
        :class="{ 'graphx-search-active': index === highlighted }"
        @mousedown.prevent="pick(hostname)"
        @mouseenter="highlighted = index"
      >
        {{ hostname }}
      </li>
    </ul>
  </div>
</template>
