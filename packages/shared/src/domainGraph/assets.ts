export type ObservedAssetRequest = {
  host: string;
  path: string;
  isJavaScript?: boolean;
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

const toIsoTimestamp = (value: number): string | undefined => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export const normalizeSeenAt = (value: unknown): string | undefined => {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === "number" && Number.isFinite(value))
    return toIsoTimestamp(value);
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return toIsoTimestamp(Number(value));
    return value.length > 0 ? value : undefined;
  }
  return undefined;
};

// HTTPQL searches the full captured response, including the body. Confirm
// the MIME value in actual response headers before accepting a non-JS path.
export const JS_MIME_HTTPQL =
  '(resp.raw.cont:"text/javascript" or resp.raw.cont:"application/javascript")';

export const JS_ASSETS_HTTPQL = `(req.path.like:"%.js" or req.path.like:"%.mjs" or req.path.like:"%.map" or ${JS_MIME_HTTPQL}) and resp.code.lt:400 and resp.raw.ncont:"ontent-Type: text/html"`;

export const isJavaScriptResponse = (response: string): boolean => {
  const headerEnd = response.indexOf("\r\n\r\n");
  if (headerEnd === -1) return false;
  const name = "content-type";
  let start = response.indexOf("\r\n") + 2;
  while (start < headerEnd) {
    const end = response.indexOf("\r\n", start);
    if (end === -1 || end > headerEnd) return false;
    const colon = start + name.length;
    if (
      response.charCodeAt(colon) === 58 &&
      response.slice(start, colon).toLowerCase() === name
    ) {
      const semicolon = response.indexOf(";", colon + 1);
      const valueEnd = semicolon !== -1 && semicolon < end ? semicolon : end;
      const mime = response
        .slice(colon + 1, valueEnd)
        .trim()
        .toLowerCase();
      return mime === "text/javascript" || mime === "application/javascript";
    }
    start = end + 2;
  }
  return false;
};

export const classifyAssetPath = (
  path: string,
  isJavaScript = false,
): AssetKind | undefined => {
  const clean = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  if (clean.endsWith(".map")) return "map";
  if (clean.endsWith(".js") || clean.endsWith(".mjs")) return "bundle";
  return isJavaScript ? "bundle" : undefined;
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
    const kind = classifyAssetPath(request.path, request.isJavaScript);
    if (kind === undefined) continue;
    const host = request.host.trim().toLowerCase();
    if (host.length === 0) continue;
    const path = request.path.split(/[?#]/, 1)[0] ?? request.path;

    if (kind === "map") {
      const paths = mapsByHost.get(host) ?? new Set<string>();
      paths.add(path);
      mapsByHost.set(host, paths);
      if (request.seenAt !== undefined) {
        const latest = mapLastSeenByHost.get(host);
        if (latest === undefined || request.seenAt > latest)
          mapLastSeenByHost.set(host, request.seenAt);
      }
      continue;
    }

    const bundles = bundlesByHost.get(host) ?? new Map();
    const existing = bundles.get(path);
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
    bundles.set(path, entry);
    bundlesByHost.set(host, bundles);
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
