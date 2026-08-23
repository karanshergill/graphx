import type { ApiMapResponse } from "shared";
import { readonly, ref } from "vue";

import { useSDK } from "@/plugins/sdk";

type LoadState = "idle" | "loading" | "ready" | "error";

export const useApiMap = () => {
  const sdk = useSDK();
  const cache = new Map<string, ApiMapResponse>();
  const apiMap = ref<ApiMapResponse>();
  const state = ref<LoadState>("idle");
  let generation = 0;

  const load = async (host: string): Promise<void> => {
    const cached = cache.get(host);
    if (cached !== undefined) {
      apiMap.value = cached;
      state.value = "ready";
      return;
    }
    const current = ++generation;
    state.value = "loading";
    const result = await sdk.backend.getApiMap(host);
    if (current !== generation) return;
    if (result.kind === "Error") {
      state.value = "error";
      sdk.window.showToast(result.error, { variant: "error" });
      return;
    }
    cache.set(host, result.value);
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
