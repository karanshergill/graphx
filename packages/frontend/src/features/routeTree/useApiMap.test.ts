import { type ApiMapResponse, buildApiMap, ok, type Result } from "shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRenderer, type Ref } from "vue";

import { SDKPlugin } from "../../plugins/sdk";
import type { FrontendSDK } from "../../types";

import { useApiMap } from "./useApiMap";

type HostNode = { parent?: HostNode; children: HostNode[] };
const node = (): HostNode => ({ children: [] });
const renderer = createRenderer<HostNode, HostNode>({
  createElement: node,
  createText: node,
  createComment: node,
  setText: () => {},
  setElementText: () => {},
  patchProp: () => {},
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove(child) {
    const siblings = child.parent?.children;
    if (siblings !== undefined) siblings.splice(siblings.indexOf(child), 1);
  },
  parentNode: (child) => child.parent ?? null,
  nextSibling: () => null,
});

const mapFor = (path: string): ApiMapResponse => ({
  routes: buildApiMap([path], []),
  routeCount: 1,
  sitemapEndpoints: 1,
  requestsScanned: 0,
  truncated: false,
});

type ApiMapView = {
  apiMap: Readonly<Ref<ApiMapResponse | undefined>>;
  state: Readonly<Ref<string>>;
  load: (host: string, scopeId?: string) => Promise<void>;
  refresh: (host: string, scopeId?: string) => Promise<void>;
  clear: () => void;
  invalidate: () => void;
};

const mountedApps: { unmount: () => void }[] = [];
const mountMap = () => {
  const getApiMap = vi.fn<FrontendSDK["backend"]["getApiMap"]>();
  let projectChanged: (() => void) | undefined;
  let view: ApiMapView | undefined;
  const sdk = {
    backend: {
      getApiMap,
      onEvent: (_event: string, callback: () => void) => {
        projectChanged = callback;
        return { stop: () => {} };
      },
    },
    window: { showToast: () => {} },
  } as unknown as FrontendSDK;
  const app = renderer.createApp({
    setup() {
      view = useApiMap();
      return () => null;
    },
  });
  app.use(SDKPlugin, sdk);
  app.mount(node());
  mountedApps.push(app);
  if (view === undefined) throw new Error("API map composable did not mount.");
  return { view, getApiMap, projectChanged: () => projectChanged?.() };
};

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
});

describe("API map cache lifecycle", () => {
  it("keeps a reselected cached host when an older pending load finishes", async () => {
    const { view, getApiMap } = mountMap();
    const pending = Promise.withResolvers<Result<ApiMapResponse>>();
    getApiMap
      .mockResolvedValueOnce(ok(mapFor("/selected")))
      .mockReturnValueOnce(pending.promise);
    await view.load("selected.example", "scope");
    const oldLoad = view.load("other.example", "scope");
    await view.load("selected.example", "scope");
    pending.resolve(ok(mapFor("/other")));
    await oldLoad;
    expect(view.apiMap.value?.routes[0]?.template).toBe("/selected");
  });

  it("refreshes cached routes from newly captured data", async () => {
    const { view, getApiMap } = mountMap();
    const pending = Promise.withResolvers<Result<ApiMapResponse>>();
    getApiMap
      .mockResolvedValueOnce(ok(mapFor("/before")))
      .mockReturnValueOnce(pending.promise);
    await view.load("example.com", "scope");
    const refreshing = view.refresh("example.com", "scope");
    expect(view.state.value).toBe("loading");
    expect(view.apiMap.value).toBeUndefined();
    pending.resolve(ok(mapFor("/after")));
    await refreshing;
    expect(view.apiMap.value?.routes[0]?.template).toBe("/after");
    view.clear();
    await view.load("example.com", "scope");
    expect(view.apiMap.value?.routes[0]?.template).toBe("/after");
  });

  it("invalidates completed maps and rejects in-flight results from before Sync", async () => {
    const { view, getApiMap } = mountMap();
    const pending = Promise.withResolvers<Result<ApiMapResponse>>();
    getApiMap
      .mockResolvedValueOnce(ok(mapFor("/before")))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(ok(mapFor("/after")))
      .mockResolvedValueOnce(ok(mapFor("/latest-other")));
    await view.load("example.com", "scope");
    const oldLoad = view.load("other.example", "scope");
    view.invalidate();
    pending.resolve(ok(mapFor("/stale-other")));
    await oldLoad;
    expect(view.apiMap.value).toBeUndefined();
    expect(view.state.value).toBe("idle");
    await view.load("example.com", "scope");
    expect(view.apiMap.value?.routes[0]?.template).toBe("/after");
    await view.load("other.example", "scope");
    expect(view.apiMap.value?.routes[0]?.template).toBe("/latest-other");
  });

  it("does not restore a stale cached map after a refresh error", async () => {
    const { view, getApiMap } = mountMap();
    getApiMap
      .mockResolvedValueOnce(ok(mapFor("/before")))
      .mockResolvedValueOnce({ kind: "Error", error: "Project unavailable" })
      .mockResolvedValueOnce(ok(mapFor("/after")));
    await view.load("example.com", "scope");
    await view.refresh("example.com", "scope");
    expect(view.apiMap.value).toBeUndefined();
    expect(view.state.value).toBe("error");
    await view.load("example.com", "scope");
    expect(view.apiMap.value?.routes[0]?.template).toBe("/after");
  });

  it("clears visible routes and cache when the project changes", async () => {
    const { view, getApiMap, projectChanged } = mountMap();
    getApiMap
      .mockResolvedValueOnce(ok(mapFor("/old-project")))
      .mockResolvedValueOnce(ok(mapFor("/new-project")));
    await view.load("example.com", "scope");
    projectChanged();
    expect(view.apiMap.value).toBeUndefined();
    expect(view.state.value).toBe("idle");
    await view.load("example.com", "scope");
    expect(view.apiMap.value?.routes[0]?.template).toBe("/new-project");
  });
});
