import type { ApiMapResponse } from "shared";
import { onBeforeUnmount, readonly, ref } from "vue";

import { useSDK } from "@/plugins/sdk";

type LoadState = "idle" | "loading" | "ready" | "error";

export const useApiMap = () => {
  const sdk = useSDK();
  const cache = new Map<string, ApiMapResponse>();
  const apiMap = ref<ApiMapResponse>();
  const state = ref<LoadState>("idle");
  let generation = 0;

  // Maps are built from project-scoped traffic; never serve cached entries
  // from a previous project.
  const stopProjectListener = sdk.backend.onEvent("project:changed", () => {
    cache.clear();
    generation += 1;
  });
  onBeforeUnmount(() => stopProjectListener.stop());

  const load = async (host: string, scopeId?: string): Promise<void> => {
    const cacheKey = `${scopeId ?? ""}:${host}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      apiMap.value = cached;
      state.value = "ready";
      return;
    }
    const current = ++generation;
    state.value = "loading";
    const result = await sdk.backend.getApiMap(host, scopeId);
    if (current !== generation) return;
    if (result.kind === "Error") {
      state.value = "error";
      sdk.window.showToast(result.error, { variant: "error" });
      return;
    }
    cache.set(cacheKey, result.value);
    apiMap.value = result.value;
    state.value = "ready";
  };

  const clear = (): void => {
    generation += 1;
    apiMap.value = undefined;
    state.value = "idle";
  };

  return {
    apiMap: readonly(apiMap),
    clear,
    load,
    state: readonly(state),
  };
};
