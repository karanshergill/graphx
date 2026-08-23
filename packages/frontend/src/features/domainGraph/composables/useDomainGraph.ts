import {
  buildDomainGraph,
  type DomainGraphSnapshot,
  type ProjectContext,
  type ScopeDefinition,
} from "shared";
import { onBeforeUnmount, ref, shallowRef, watch } from "vue";

import {
  readScopes,
  readSitemapDomains,
  subscribeToSitemapDomains,
} from "../adapters";
import { useDomainGraphPageActive } from "../pageActivity";

import { useSDK } from "@/plugins/sdk";

type LoadState = "idle" | "loading" | "ready" | "error";
type ListenerHandle = { stop: () => void };

const RECONCILIATION_INTERVAL_MS = 5_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const snapshotRevision = (snapshot: DomainGraphSnapshot): string =>
  JSON.stringify({
    scope: snapshot.scope,
    nodes: snapshot.nodes,
    relationships: snapshot.relationships,
  });

export const useDomainGraph = () => {
  const sdk = useSDK();
  const isActive = useDomainGraphPageActive();
  const project = shallowRef<ProjectContext>();
  const scopes = ref<ScopeDefinition[]>([]);
  const selectedScopeId = ref<string>();
  const snapshot = shallowRef<DomainGraphSnapshot>();
  const lastRefreshAt = ref<string>();
  const state = ref<LoadState>("idle");
  const error = ref<string>();
  const listeners: ListenerHandle[] = [];
  let sitemapSubscription: ListenerHandle | undefined;
  let subscribedScopeId: string | undefined;
  let refreshTimer: number | undefined;
  let reconciliationTimer: number | undefined;
  let refreshGeneration = 0;
  let revision: string | undefined;
  let running = false;

  const selectDefaultScope = (): void => {
    if (scopes.value.length === 0) {
      selectedScopeId.value = undefined;
      return;
    }

    const selectedExists = scopes.value.some(
      (scope) => scope.id === selectedScopeId.value,
    );
    if (selectedExists) return;

    const sitemapScopeId = sdk.sitemap.getScopeId();
    const currentScopeId = sdk.scopes.getCurrentScope()?.id;
    const projectScopeId = scopes.value.find(
      (scope) => scope.name.toLowerCase() === project.value?.name.toLowerCase(),
    )?.id;

    selectedScopeId.value =
      [sitemapScopeId, currentScopeId, projectScopeId].find(
        (id) =>
          id !== undefined && scopes.value.some((scope) => scope.id === id),
      ) ?? scopes.value[0]?.id;
  };

  const scheduleRefresh = (): void => {
    if (!isActive.value) return;
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      void refreshGraph();
    }, 250);
  };

  const stopSitemapSubscription = (): void => {
    sitemapSubscription?.stop();
    sitemapSubscription = undefined;
    subscribedScopeId = undefined;
  };

  const ensureSitemapSubscription = (): void => {
    const scopeId = selectedScopeId.value;
    if (scopeId === undefined || scopeId === subscribedScopeId) return;

    stopSitemapSubscription();
    sitemapSubscription = subscribeToSitemapDomains(sdk, {
      scopeId,
      onChange: scheduleRefresh,
      onError: (cause) => {
        sdk.log.warn(
          "GraphX Sitemap subscription disconnected; reconciliation remains active.",
          cause,
        );
      },
    });
    subscribedScopeId = scopeId;
  };

  const refreshGraph = async (reloadProject = false): Promise<void> => {
    const generation = ++refreshGeneration;
    state.value = "loading";
    error.value = undefined;

    try {
      if (project.value === undefined || reloadProject) {
        const projectResult = await sdk.backend.getProjectContext();
        if (generation !== refreshGeneration) return;
        if (projectResult.kind === "Error") {
          error.value = projectResult.error;
          project.value = undefined;
          snapshot.value = undefined;
          state.value = "error";
          return;
        }
        project.value = projectResult.value;
      }

      scopes.value = readScopes(sdk);
      selectDefaultScope();
      const scope = scopes.value.find(
        (candidate) => candidate.id === selectedScopeId.value,
      );
      if (scope === undefined) {
        snapshot.value = undefined;
        error.value = "Create or select a Caido scope to build this graph.";
        state.value = "error";
        return;
      }

      ensureSitemapSubscription();
      const entries = await readSitemapDomains(sdk, scope.id);
      if (generation !== refreshGeneration) return;

      const nextSnapshot = buildDomainGraph({
        scope,
        entries,
        generatedAt: new Date().toISOString(),
      });
      const nextRevision = snapshotRevision(nextSnapshot);
      if (nextRevision !== revision) {
        snapshot.value = nextSnapshot;
        revision = nextRevision;
      }
      lastRefreshAt.value = nextSnapshot.generatedAt;
      state.value = "ready";
    } catch (cause: unknown) {
      if (generation !== refreshGeneration) return;
      snapshot.value = undefined;
      error.value = errorMessage(cause);
      state.value = "error";
    }
  };

  const selectScope = (scopeId: string): void => {
    refreshGeneration += 1;
    selectedScopeId.value = scopeId;
    stopSitemapSubscription();
    void refreshGraph();
  };

  const stop = (): void => {
    if (!running) return;
    running = false;
    refreshGeneration += 1;
    revision = undefined;
    project.value = undefined;
    snapshot.value = undefined;
    lastRefreshAt.value = undefined;
    state.value = "idle";
    error.value = undefined;
    for (const listener of listeners.splice(0)) listener.stop();
    stopSitemapSubscription();
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
    if (reconciliationTimer !== undefined) {
      window.clearInterval(reconciliationTimer);
    }
    reconciliationTimer = undefined;
  };

  const start = (): void => {
    if (running) return;
    running = true;
    listeners.push(
      sdk.backend.onEvent("project:changed", () => {
        refreshGeneration += 1;
        revision = undefined;
        project.value = undefined;
        snapshot.value = undefined;
        stopSitemapSubscription();
        scheduleRefresh();
      }),
      sdk.scopes.onCurrentScopeChange(({ scopeId }) => {
        refreshGeneration += 1;
        if (scopeId !== undefined) selectedScopeId.value = scopeId;
        stopSitemapSubscription();
        scheduleRefresh();
      }),
    );
    reconciliationTimer = window.setInterval(
      scheduleRefresh,
      RECONCILIATION_INTERVAL_MS,
    );
    void refreshGraph(true);
  };

  const refresh = (): Promise<void> => refreshGraph(true);

  watch(isActive, (active) => (active ? start() : stop()), {
    immediate: true,
  });

  onBeforeUnmount(() => {
    stop();
  });

  return {
    error,
    isActive,
    lastRefreshAt,
    project,
    refresh,
    scopes,
    selectScope,
    selectedScopeId,
    snapshot,
    state,
  };
};
