<script setup lang="ts">
import Button from "primevue/button";
import Select from "primevue/select";
import type { ApiRoute } from "shared";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { RouteTreeCanvas, useApiMap } from "../../../routeTree";
import { useDomainAssets } from "../../assets";
import { useDomainGraph } from "../../composables";
import {
  collectConnectionPath,
  collectDescendants,
  projectMarkedSubgraph,
  useDomainMarks,
} from "../../marking";
import type { DomainGraphView } from "../../rendering";
import { DomainSearch } from "../DomainSearch";
import { GraphCanvas } from "../GraphCanvas";
import { MarkContextMenu } from "../MarkContextMenu";

import { useSDK } from "@/plugins/sdk";

const {
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
} = useDomainGraph();
const graphProjection = computed(() =>
  snapshot.value === undefined
    ? undefined
    : {
        nodes: snapshot.value.nodes,
        relationships: snapshot.value.relationships,
      },
);
const { mark, markedCount, marks, unmark } = useDomainMarks();
const { assetsByHost, assetsTruncated, hostsWithJs } = useDomainAssets({
  selectedScopeId,
  lastRefreshAt,
});
const sdk = useSDK();

const requireMarks = (): boolean => {
  if (markedCount.value > 0) return true;
  sdk.window.showToast(
    "Mark a domain first — right-click a node, or select one and press M.",
    { variant: "info" },
  );
  return false;
};

const toggleMarkedOnly = (): void => {
  if (showMarkedOnly.value || requireMarks())
    showMarkedOnly.value = !showMarkedOnly.value;
};

const markedOnlyLabel = computed(() =>
  showAssets.value ? "Marked + JS emphasis" : "Show marked domains only",
);

const toggleConnectionPaths = (): void => {
  if (showConnectionPaths.value || requireMarks())
    showConnectionPaths.value = !showConnectionPaths.value;
};

const showMarkedOnly = ref(false);
const showConnectionPaths = ref(false);
const showAssets = ref(false);
const menuTarget = ref<{ hostname: string; x: number; y: number }>();

const combinedEmphasis = computed(
  () => showMarkedOnly.value && showAssets.value,
);

const view = computed<DomainGraphView | undefined>(() => {
  const projection = graphProjection.value;
  if (projection === undefined) return undefined;
  const filtered =
    showMarkedOnly.value && !combinedEmphasis.value
      ? projectMarkedSubgraph(projection, marks.value)
      : projection;
  let prominentHosts: Set<string> | undefined;
  if (combinedEmphasis.value) {
    prominentHosts = new Set(marks.value);
    for (const [host, assets] of assetsByHost.value) {
      if (assets.bundleCount > 0) prominentHosts.add(host);
    }
  }
  return {
    nodes: filtered.nodes,
    relationships: filtered.relationships,
    marks: marks.value,
    connectionPath:
      showConnectionPaths.value && marks.value.size > 0
        ? collectConnectionPath(filtered, marks.value)
        : undefined,
    assets: { byHost: assetsByHost.value, active: showAssets.value },
    prominentHosts,
  };
});

const selectedHostname = ref<string>();
const renderError = ref<string>();
const selectedNode = computed(() =>
  snapshot.value?.nodes.find(
    (node) => node.hostname === selectedHostname.value,
  ),
);
const selectedHostAssets = computed(() => {
  const hostname = selectedHostname.value;
  if (hostname === undefined) return undefined;
  return assetsByHost.value.get(hostname);
});

const copyAssetUrls = (): void => {
  const assets = selectedHostAssets.value;
  const hostname = selectedHostname.value;
  if (assets === undefined || hostname === undefined) return;
  void navigator.clipboard.writeText(
    assets.bundles
      .map((bundle) => `https://${hostname}${bundle.path}`)
      .join("\n"),
  );
  sdk.window.showToast(
    `Copied ${assets.bundleCount} bundle URL${assets.bundleCount === 1 ? "" : "s"}`,
    { variant: "success" },
  );
};
const statusMessage = computed(() => renderError.value ?? error.value);

watch(snapshot, () => {
  renderError.value = undefined;
  if (selectedNode.value === undefined) selectedHostname.value = undefined;
});

const onScopeChange = (scopeId: string | undefined): void => {
  if (scopeId !== undefined) selectScope(scopeId);
};

const menuMarked = computed(
  () =>
    menuTarget.value !== undefined &&
    marks.value.has(menuTarget.value.hostname),
);
const menuDescendantCount = computed(() => {
  const target = menuTarget.value;
  if (target === undefined || snapshot.value === undefined) return 0;
  return collectDescendants(snapshot.value, target.hostname).length;
});

const menuHostnames = (includeSubdomains: boolean): string[] => {
  const target = menuTarget.value;
  if (target === undefined || snapshot.value === undefined) return [];
  if (!includeSubdomains) return [target.hostname];
  return [
    target.hostname,
    ...collectDescendants(snapshot.value, target.hostname),
  ];
};

const onMenuMark = (includeSubdomains: boolean): void => {
  void mark(menuHostnames(includeSubdomains));
};

const onMenuUnmark = (includeSubdomains: boolean): void => {
  void unmark(menuHostnames(includeSubdomains));
};

const onMarkSelected = (includeSubdomains: boolean): void => {
  const hostname = selectedHostname.value;
  if (hostname === undefined || snapshot.value === undefined) return;
  if (!includeSubdomains) {
    if (marks.value.has(hostname)) void unmark([hostname]);
    else void mark([hostname]);
    return;
  }
  void mark([hostname, ...collectDescendants(snapshot.value, hostname)]);
};

const searchHostnames = computed(() =>
  (snapshot.value?.nodes ?? []).map((node) => node.hostname),
);
const searchBox = ref<{ focus: () => void }>();
const graphCanvas = ref<{ focusNode: (hostname: string) => void }>();

const onSearchJump = (hostname: string): void => {
  graphCanvas.value?.focusNode(hostname);
};

const onGlobalKeydown = (event: KeyboardEvent): void => {
  if (!isActive.value) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  ) {
    return;
  }
  const isSlash = event.key === "/";
  const isSearchShortcut =
    (event.key === "k" || event.key === "K") &&
    (event.ctrlKey || event.metaKey);
  if (isSlash || isSearchShortcut) {
    event.preventDefault();
    searchBox.value?.focus();
  }
};

onMounted(() => {
  document.addEventListener("keydown", onGlobalKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
});

const drillHost = ref<string>();
const selectedEndpoint = ref<ApiRoute>();
const {
  apiMap,
  clear: clearApiMap,
  load: loadApiMap,
  state: apiMapState,
} = useApiMap();

const drillIn = (hostname: string): void => {
  selectedEndpoint.value = undefined;
  drillHost.value = hostname;
  void loadApiMap(hostname, selectedScopeId.value);
};

const drillOut = (): void => {
  drillHost.value = undefined;
  selectedEndpoint.value = undefined;
  renderError.value = undefined;
  clearApiMap();
};

// A project or scope switch invalidates the cached maps; leave the drill-down
// so the old context's routes are never shown as if they were current.
watch([() => project.value?.id, selectedScopeId], () => {
  if (drillHost.value !== undefined) drillOut();
});

const onDrilldown = (): void => {
  const hostname = selectedHostname.value;
  if (hostname !== undefined) {
    renderError.value = undefined;
    drillIn(hostname);
  }
};

const copyRouteTemplate = (): void => {
  const endpoint = selectedEndpoint.value;
  const host = drillHost.value;
  if (endpoint === undefined || host === undefined) return;
  void navigator.clipboard.writeText(`https://${host}${endpoint.template}`);
  sdk.window.showToast("Route URL copied", { variant: "success" });
};
</script>

<template>
  <section class="graphx-page" aria-labelledby="graphx-title">
    <header class="graphx-toolbar">
      <div class="graphx-identity">
        <span class="graphx-logo" aria-hidden="true">
          <i class="fas fa-project-diagram" />
        </span>
        <div>
          <h1 id="graphx-title">GraphX</h1>
          <p>{{ project?.name ?? "No project selected" }}</p>
        </div>
      </div>

      <div class="graphx-controls">
        <DomainSearch
          ref="searchBox"
          :hostnames="searchHostnames"
          @jump="onSearchJump"
        />
        <label for="graphx-scope">Program scope</label>
        <Select
          id="graphx-scope"
          :model-value="selectedScopeId"
          :options="scopes"
          option-label="name"
          option-value="id"
          placeholder="Select scope"
          class="graphx-scope-select"
          @update:model-value="onScopeChange"
        />
        <Button
          icon="fas fa-bookmark"
          severity="secondary"
          :text="!showMarkedOnly"
          :aria-pressed="showMarkedOnly"
          :aria-label="markedOnlyLabel"
          :title="markedOnlyLabel"
          @click="toggleMarkedOnly"
        />
        <Button
          icon="fas fa-route"
          severity="secondary"
          :text="!showConnectionPaths"
          :aria-pressed="showConnectionPaths"
          aria-label="Highlight connection paths between marked domains"
          title="Connection paths"
          @click="toggleConnectionPaths"
        />
        <Button
          icon="fas fa-file-code"
          severity="secondary"
          :text="!showAssets"
          :aria-pressed="showAssets"
          aria-label="Highlight hosts with observed JavaScript bundles"
          title="JS assets"
          @click="showAssets = !showAssets"
        />
        <Button
          icon="fas fa-sync-alt"
          severity="secondary"
          text
          :loading="state === 'loading'"
          aria-label="Refresh domain graph"
          @click="refresh"
        />
      </div>

      <dl v-if="snapshot" class="graphx-stats" aria-label="Graph summary">
        <div>
          <dt>Observed</dt>
          <dd>{{ snapshot.stats.observedHosts }}</dd>
        </div>
        <div>
          <dt>Subdomains</dt>
          <dd>{{ snapshot.stats.observedSubdomains }}</dd>
        </div>
        <div>
          <dt>Marked</dt>
          <dd>{{ markedCount }}</dd>
        </div>
        <div v-if="showAssets">
          <dt>With JS</dt>
          <dd>{{ hostsWithJs }}</dd>
        </div>
        <div>
          <dt>Relations</dt>
          <dd>{{ snapshot.stats.relationships }}</dd>
        </div>
        <div>
          <dt>Depth</dt>
          <dd>{{ snapshot.stats.maxDepth }}</dd>
        </div>
      </dl>
    </header>

    <main class="graphx-workspace">
      <template v-if="drillHost === undefined">
        <GraphCanvas
          v-if="isActive && view && view.nodes.length > 0"
          ref="graphCanvas"
          :view="view"
          @select="selectedHostname = $event"
          @error="renderError = $event"
          @nodecontextmenu="menuTarget = $event"
          @markselected="onMarkSelected"
          @drilldown="onDrilldown"
        />

        <div v-else-if="state === 'loading'" class="graphx-state" role="status">
          <i class="fas fa-circle-notch fa-spin" aria-hidden="true" />
          <span>Reading Caido Sitemap domains…</span>
        </div>

        <div
          v-else-if="statusMessage"
          class="graphx-state graphx-state-error"
          role="alert"
        >
          <i class="fas fa-exclamation-triangle" aria-hidden="true" />
          <span>{{ statusMessage }}</span>
        </div>

        <div
          v-else-if="showMarkedOnly && markedCount > 0"
          class="graphx-state"
          role="status"
        >
          <i class="fas fa-bookmark" aria-hidden="true" />
          <span>No marked domains are visible in this scope and depth.</span>
        </div>

        <div v-else class="graphx-state">
          <i class="fas fa-project-diagram" aria-hidden="true" />
          <span>No in-scope Sitemap domains were found.</span>
        </div>

        <div
          v-if="renderError && snapshot && snapshot.nodes.length > 0"
          class="graphx-state graphx-state-error"
          role="alert"
        >
          <i class="fas fa-exclamation-triangle" aria-hidden="true" />
          <span>{{ renderError }}</span>
        </div>

        <MarkContextMenu
          v-if="menuTarget"
          :x="menuTarget.x"
          :y="menuTarget.y"
          :hostname="menuTarget.hostname"
          :marked="menuMarked"
          :descendant-count="menuDescendantCount"
          @mark="onMenuMark(false)"
          @marksubtree="onMenuMark(true)"
          @unmark="onMenuUnmark(false)"
          @unmarksubtree="onMenuUnmark(true)"
          @close="menuTarget = undefined"
        />

        <aside v-if="selectedNode" class="graphx-selection" aria-live="polite">
          <span>{{
            selectedNode.observed ? "Observed in Sitemap" : "Structural parent"
          }}</span>
          <strong>{{ selectedNode.hostname }}</strong>
          <small
            >Depth {{ selectedNode.depth }} · {{ selectedNode.kind
            }}<template v-if="marks.has(selectedNode.hostname)">
              · Marked</template
            ></small
          >
          <div
            v-if="selectedHostAssets && selectedHostAssets.bundleCount > 0"
            class="graphx-assets"
          >
            <div class="graphx-assets-header">
              <span
                >JS bundles · {{ selectedHostAssets.bundleCount }} · maps
                {{ selectedHostAssets.mapCount
                }}<template v-if="selectedHostAssets.lastSeen">
                  · last seen
                  {{ selectedHostAssets.lastSeen.slice(0, 10) }}</template
                ></span
              >
              <button type="button" @click="copyAssetUrls">Copy URLs</button>
            </div>
            <p v-if="assetsTruncated" class="graphx-assets-more">
              Asset sweep truncated — data may be incomplete.
            </p>
            <ul>
              <li
                v-for="bundle in selectedHostAssets.bundles.slice(0, 50)"
                :key="bundle.path"
              >
                <code>{{ bundle.path }}</code>
                <span class="graphx-asset-meta"
                  >×{{ bundle.requestCount
                  }}<template v-if="bundle.lastStatus !== undefined">
                    · {{ bundle.lastStatus }}</template
                  ><template v-if="bundle.lastSeen">
                    · {{ bundle.lastSeen.slice(0, 10) }}</template
                  ></span
                >
                <span v-if="bundle.hasMap" class="graphx-asset-map">map</span>
              </li>
            </ul>
            <p
              v-if="selectedHostAssets.bundleCount > 50"
              class="graphx-assets-more"
            >
              + {{ selectedHostAssets.bundleCount - 50 }} more
            </p>
          </div>
          <button
            type="button"
            class="graphx-apimap-button"
            @click="onDrilldown"
          >
            <i class="fas fa-sitemap" aria-hidden="true" /> Open API map
            <kbd>Enter</kbd>
          </button>
        </aside>

        <div v-if="snapshot" class="graphx-legend" aria-label="Graph legend">
          <span><i class="graphx-dot graphx-dot-root" />Root domain</span>
          <span><i class="graphx-dot graphx-dot-observed" />Observed host</span>
          <span
            ><i class="graphx-dot graphx-dot-structural" />Structural
            parent</span
          >
          <span><i class="graphx-dot graphx-dot-marked" />Marked</span>
          <span v-if="showConnectionPaths && markedCount > 0"
            ><i class="graphx-line-path" />Connection path</span
          >
          <span v-if="showAssets"
            ><i class="fas fa-file-code" />Host with JS bundles</span
          >
        </div>

        <section
          v-if="view"
          class="graphx-sr-only"
          aria-label="Domain relationships"
        >
          <h2>Domains</h2>
          <ul>
            <li v-for="node in view.nodes" :key="node.id">
              {{ node.hostname }},
              {{ node.observed ? "observed" : "structural" }}, depth
              {{ node.depth }}{{ marks.has(node.hostname) ? ", marked" : "" }}
            </li>
          </ul>
          <h2>Relationships</h2>
          <ul>
            <li
              v-for="relationship in view.relationships"
              :key="relationship.id"
            >
              {{ relationship.source.replace("domain:", "") }} is parent of
              {{ relationship.target.replace("domain:", "") }}
            </li>
          </ul>
        </section>
      </template>

      <template v-else>
        <div class="graphx-drill">
          <div class="graphx-breadcrumb">
            <button type="button" @click="drillOut">
              <i class="fas fa-arrow-left" aria-hidden="true" /> Domains
            </button>
            <strong>{{ drillHost }}</strong>
            <span v-if="apiMap" class="graphx-breadcrumb-meta"
              >{{ apiMap.routeCount }} routes ·
              {{ apiMap.sitemapEndpoints }} sitemap endpoints</span
            >
          </div>
          <div class="graphx-drill-canvas">
            <div
              v-if="renderError"
              class="graphx-state graphx-state-error"
              role="alert"
            >
              <i class="fas fa-exclamation-triangle" aria-hidden="true" />
              <span>{{ renderError }}</span>
            </div>
            <RouteTreeCanvas
              v-if="apiMapState === 'ready' && apiMap"
              :api-map="apiMap"
              :host="drillHost"
              @select="selectedEndpoint = $event"
              @back="drillOut"
              @error="renderError = $event"
            />
            <div
              v-else-if="apiMapState === 'loading'"
              class="graphx-state"
              role="status"
            >
              <i class="fas fa-circle-notch fa-spin" aria-hidden="true" />
              <span>Building API map for {{ drillHost }}…</span>
            </div>
            <div v-else class="graphx-state graphx-state-error" role="alert">
              <i class="fas fa-exclamation-triangle" aria-hidden="true" />
              <span>Could not build the API map for {{ drillHost }}.</span>
            </div>
          </div>
          <aside
            v-if="selectedEndpoint"
            class="graphx-selection graphx-route-details"
            aria-live="polite"
          >
            <span>Route</span>
            <strong>{{ selectedEndpoint.template }}</strong>
            <small>
              <template
                v-for="(count, method) in selectedEndpoint.methods"
                :key="method"
                >{{ method }}×{{ count }}&nbsp;</template
              >
            </small>
            <small>
              <template
                v-for="(count, status) in selectedEndpoint.statuses"
                :key="status"
                >{{ status }}×{{ count }}&nbsp;</template
              >
            </small>
            <small v-if="selectedEndpoint.queryKeys.length > 0"
              >?{{ selectedEndpoint.queryKeys.join(" & ") }}</small
            >
            <small>example: {{ selectedEndpoint.examplePath }}</small>
            <small v-if="selectedEndpoint.lastSeen"
              >last seen {{ selectedEndpoint.lastSeen.slice(0, 10)
              }}<template v-if="!selectedEndpoint.inSitemap">
                · not in sitemap</template
              ></small
            >
            <button type="button" @click="copyRouteTemplate">Copy URL</button>
          </aside>
          <div class="graphx-legend" aria-label="Route map legend">
            <span><i class="graphx-dot graphx-dot-observed" />Endpoint</span>
            <span><i class="graphx-dot graphx-dot-neighbor" />Has 4xx</span>
            <span><i class="graphx-dot graphx-dot-danger" />Has 5xx</span>
            <span><i class="graphx-dot graphx-dot-path" />Parameter</span>
            <span><i class="graphx-dot graphx-dot-structural" />Segment</span>
          </div>
        </div>
      </template>
    </main>
  </section>
</template>
