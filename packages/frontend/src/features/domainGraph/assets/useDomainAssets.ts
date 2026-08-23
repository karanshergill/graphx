import { groupAssetsByHost, type HostAssets } from "shared";
import { computed, onBeforeUnmount, readonly, ref, type Ref, watch } from "vue";

import { useDomainGraphPageActive } from "../pageActivity";

import {
  readJsAssetRequests,
  readJsAssetRequestsSnapshot,
} from "./caidoRequests";

import { useSDK } from "@/plugins/sdk";

type LoadState = "idle" | "loading" | "ready" | "error";

type DomainAssetsInput = {
  selectedScopeId: Readonly<Ref<string | undefined>>;
  lastRefreshAt: Readonly<Ref<string | undefined>>;
};

export const useDomainAssets = ({
  selectedScopeId,
  lastRefreshAt,
}: DomainAssetsInput) => {
  const sdk = useSDK();
  const isActive = useDomainGraphPageActive();
  const assetsByHost = ref<ReadonlyMap<string, HostAssets>>(new Map());
  const assetsTruncated = ref(false);
  const state = ref<LoadState>("idle");
  let running = false;
  let probing = false;
  let generation = 0;
  let fetchedSnapshot = -1;

  const probe = async (): Promise<void> => {
    const scopeId = selectedScopeId.value;
    if (!running || probing || scopeId === undefined) return;
    probing = true;
    const current = ++generation;
    try {
      const token = await readJsAssetRequestsSnapshot(sdk, scopeId);
      if (current !== generation || token === fetchedSnapshot) return;
      state.value = "loading";
      const sweep = await readJsAssetRequests(sdk, scopeId);
      if (current !== generation) return;
      assetsByHost.value = groupAssetsByHost(sweep.requests);
      assetsTruncated.value = sweep.truncated;
      fetchedSnapshot = token;
      state.value = "ready";
    } catch (cause: unknown) {
      if (current !== generation) return;
      state.value = "error";
      const message = cause instanceof Error ? cause.message : String(cause);
      sdk.log.warn(`GraphX asset sweep failed: ${message}`);
      sdk.window.showToast(`GraphX asset sweep failed: ${message}`, {
        variant: "error",
      });
    } finally {
      probing = false;
    }
  };

  const start = (): void => {
    if (running) return;
    running = true;
    void probe();
  };

  const stop = (): void => {
    running = false;
    generation += 1;
    fetchedSnapshot = -1;
    assetsByHost.value = new Map();
    assetsTruncated.value = false;
    state.value = "idle";
  };

  watch(isActive, (active) => (active ? start() : stop()), {
    immediate: true,
  });

  watch(selectedScopeId, () => {
    generation += 1;
    fetchedSnapshot = -1;
    assetsByHost.value = new Map();
    assetsTruncated.value = false;
    void probe();
  });

  watch(lastRefreshAt, () => void probe());

  onBeforeUnmount(stop);

  return {
    assetsByHost: readonly(assetsByHost),
    assetsTruncated: readonly(assetsTruncated),
    hostsWithJs: computed(() => assetsByHost.value.size),
    state: readonly(state),
  };
};
