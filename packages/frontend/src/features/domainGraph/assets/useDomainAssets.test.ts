import type { HostAssets, ObservedAssetRequest } from "shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRenderer, nextTick, ref, type Ref } from "vue";

import { SDKPlugin } from "../../../plugins/sdk";
import type { FrontendSDK } from "../../../types";
import { setDomainGraphPageActive } from "../pageActivity";

import {
  readJsAssetRequests,
  readJsAssetRequestsSnapshot,
} from "./caidoRequests";
import { useDomainAssets } from "./useDomainAssets";

vi.mock("./caidoRequests", () => ({
  readJsAssetRequests: vi.fn(),
  readJsAssetRequestsSnapshot: vi.fn(),
}));

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

type AssetView = {
  assetsByHost: Readonly<Ref<ReadonlyMap<string, HostAssets>>>;
  state: Readonly<Ref<string>>;
};
const mountedApps: { unmount: () => void }[] = [];
const mountAssets = (
  scope: Ref<string | undefined>,
  refresh: Ref<string | undefined>,
) => {
  let assets: AssetView | undefined;
  const app = renderer.createApp({
    setup() {
      assets = useDomainAssets({
        selectedScopeId: scope,
        lastRefreshAt: refresh,
      });
      return () => null;
    },
  });
  app.use(SDKPlugin, {} as FrontendSDK);
  app.mount(node());
  mountedApps.push(app);
  if (assets === undefined) throw new Error("Asset composable did not mount.");
  return assets;
};

afterEach(async () => {
  for (const app of mountedApps.splice(0)) app.unmount();
  setDomainGraphPageActive(false);
  await nextTick();
  vi.resetAllMocks();
});

describe("JS assets probe lifecycle", () => {
  it.each(["snapshot", "sweep"] as const)(
    "loads the latest scope when the old %s is still in flight",
    async (stage) => {
      const snapshotA = Promise.withResolvers<number>();
      const sweepA = Promise.withResolvers<{
        requests: ObservedAssetRequest[];
        truncated: boolean;
      }>();
      vi.mocked(readJsAssetRequestsSnapshot).mockImplementation(
        (_sdk, scope) =>
          scope === "scope-a" && stage === "snapshot"
            ? snapshotA.promise
            : Promise.resolve(scope === "scope-a" ? 1 : 2),
      );
      vi.mocked(readJsAssetRequests).mockImplementation((_sdk, scope) =>
        scope === "scope-a" && stage === "sweep"
          ? sweepA.promise
          : Promise.resolve({
              requests: [{ host: "new.example", path: "/new.js" }],
              truncated: false,
            }),
      );
      const scope = ref<string | undefined>("scope-a");
      const assets = mountAssets(scope, ref<string | undefined>());
      setDomainGraphPageActive(true);
      await vi.waitFor(() =>
        expect(
          stage === "snapshot"
            ? readJsAssetRequestsSnapshot
            : readJsAssetRequests,
        ).toHaveBeenCalledWith(expect.anything(), "scope-a"),
      );
      scope.value = "scope-b";
      await nextTick();
      if (stage === "snapshot") snapshotA.resolve(1);
      else
        sweepA.resolve({
          requests: [{ host: "old.example", path: "/old.js" }],
          truncated: false,
        });

      await vi.waitFor(() =>
        expect(
          assets.assetsByHost.value.get("new.example")?.bundles[0]?.path,
        ).toBe("/new.js"),
      );
      expect(assets.assetsByHost.value.has("old.example")).toBe(false);
      expect(assets.state.value).toBe("ready");
    },
  );

  it("rechecks assets after a graph sync during an in-flight sweep", async () => {
    const firstSweep = Promise.withResolvers<{
      requests: ObservedAssetRequest[];
      truncated: boolean;
    }>();
    let snapshots = 0;
    let sweeps = 0;
    vi.mocked(readJsAssetRequestsSnapshot).mockImplementation(() =>
      Promise.resolve(++snapshots),
    );
    vi.mocked(readJsAssetRequests).mockImplementation(() =>
      ++sweeps === 1
        ? firstSweep.promise
        : Promise.resolve({
            requests: [{ host: "updated.example", path: "/new.js" }],
            truncated: false,
          }),
    );
    const refresh = ref<string | undefined>();
    const assets = mountAssets(ref<string | undefined>("scope-a"), refresh);
    setDomainGraphPageActive(true);
    await vi.waitFor(() => expect(sweeps).toBe(1));
    refresh.value = "synced";
    await nextTick();
    firstSweep.resolve({
      requests: [{ host: "old.example", path: "/old.js" }],
      truncated: false,
    });

    await vi.waitFor(() =>
      expect(
        assets.assetsByHost.value.get("updated.example")?.bundleCount,
      ).toBe(1),
    );
    expect(assets.assetsByHost.value.has("old.example")).toBe(false);
  });

  it("reloads assets when the page closes and reopens during a probe", async () => {
    const firstSnapshot = Promise.withResolvers<number>();
    let snapshotCalls = 0;
    vi.mocked(readJsAssetRequestsSnapshot).mockImplementation(() =>
      ++snapshotCalls === 1 ? firstSnapshot.promise : Promise.resolve(2),
    );
    vi.mocked(readJsAssetRequests).mockResolvedValue({
      requests: [{ host: "reopened.example", path: "/fresh.js" }],
      truncated: false,
    });
    const assets = mountAssets(
      ref<string | undefined>("scope-a"),
      ref<string | undefined>(),
    );
    setDomainGraphPageActive(true);
    await vi.waitFor(() => expect(snapshotCalls).toBe(1));
    setDomainGraphPageActive(false);
    await nextTick();
    expect(assets.state.value).toBe("idle");
    setDomainGraphPageActive(true);
    await nextTick();
    firstSnapshot.resolve(1);

    await vi.waitFor(() =>
      expect(
        assets.assetsByHost.value.get("reopened.example")?.bundleCount,
      ).toBe(1),
    );
    expect(assets.state.value).toBe("ready");
  });
});
