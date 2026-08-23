export type ObservedAssetRequest = {
  host: string;
  path: string;
  statusCode?: number;
  seenAt?: string;
};

type BundleAsset = {
  path: string;
  requestCount: number;
  lastStatus?: number;
  hasMap: boolean;
  firstSeen?: string;
  lastSeen?: string;
};

export type HostAssets = {
  bundleCount: number;
  mapCount: number;
  bundles: readonly BundleAsset[];
  lastSeen?: string;
};

type AssetKind = "bundle" | "map";

export const normalizeSeenAt = (value: unknown): string | undefined => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value).toISOString();
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return new Date(Number(value)).toISOString();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
};

export const JS_ASSETS_HTTPQL =
  '(req.path.like:"%.js" or req.path.like:"%.mjs" or req.path.like:"%.map") and resp.code.lt:400 and resp.raw.ncont:"ontent-Type: text/html"';

export const classifyAssetPath = (path: string): AssetKind | undefined => {
  const clean = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  if (clean.endsWith(".map")) return "map";
  if (clean.endsWith(".js") || clean.endsWith(".mjs")) return "bundle";
  return undefined;
};

export const groupAssetsByHost = (
  requests: ObservedAssetRequest[],
): Map<string, HostAssets> => {
  const bundlesByHost = new Map<
    string,
    Map<
      string,
      {
        requestCount: number;
        lastStatus?: number;
        firstSeen?: string;
        lastSeen?: string;
      }
    >
  >();
  const mapsByHost = new Map<string, Set<string>>();
  const mapLastSeenByHost = new Map<string, string>();

  for (const request of requests) {
    if (request.statusCode !== undefined && request.statusCode >= 400) continue;
    const kind = classifyAssetPath(request.path);
    if (kind === undefined) continue;

    if (kind === "map") {
      const paths = mapsByHost.get(request.host) ?? new Set<string>();
      paths.add(request.path);
      mapsByHost.set(request.host, paths);
      if (request.seenAt !== undefined) {
        const latest = mapLastSeenByHost.get(request.host);
        if (latest === undefined || request.seenAt > latest)
          mapLastSeenByHost.set(request.host, request.seenAt);
      }
      continue;
    }

    const bundles = bundlesByHost.get(request.host) ?? new Map();
    const existing = bundles.get(request.path);
    const entry = {
      requestCount: (existing?.requestCount ?? 0) + 1,
      lastStatus: request.statusCode ?? existing?.lastStatus,
      firstSeen: existing?.firstSeen,
      lastSeen: existing?.lastSeen,
    };
    if (request.seenAt !== undefined) {
      if (entry.firstSeen === undefined || request.seenAt < entry.firstSeen)
        entry.firstSeen = request.seenAt;
      if (entry.lastSeen === undefined || request.seenAt > entry.lastSeen)
        entry.lastSeen = request.seenAt;
    }
    bundles.set(request.path, entry);
    bundlesByHost.set(request.host, bundles);
  }

  const hosts = new Set([...bundlesByHost.keys(), ...mapsByHost.keys()]);
  const result = new Map<string, HostAssets>();
  for (const host of [...hosts].sort()) {
    const mapPaths = mapsByHost.get(host) ?? new Set<string>();
    const bundles = [...(bundlesByHost.get(host)?.entries() ?? [])]
      .map(([path, entry]): BundleAsset => {
        const asset: BundleAsset = {
          path,
          requestCount: entry.requestCount,
          hasMap: mapPaths.has(`${path}.map`),
        };
        if (entry.lastStatus !== undefined) asset.lastStatus = entry.lastStatus;
        if (entry.firstSeen !== undefined) asset.firstSeen = entry.firstSeen;
        if (entry.lastSeen !== undefined) asset.lastSeen = entry.lastSeen;
        return asset;
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    const hostAssets: HostAssets = {
      bundleCount: bundles.length,
      mapCount: mapPaths.size,
      bundles,
    };
    const lastSeen = bundles.reduce<string | undefined>(
      (latest, bundle) =>
        bundle.lastSeen !== undefined &&
        (latest === undefined || bundle.lastSeen > latest)
          ? bundle.lastSeen
          : latest,
      mapLastSeenByHost.get(host),
    );
    if (lastSeen !== undefined) hostAssets.lastSeen = lastSeen;
    result.set(host, hostAssets);
  }
  return result;
};
