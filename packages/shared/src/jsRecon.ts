export type JsReconExtraction = {
  endpoints: string[];
  graphqlOperations: string[];
  storageKeys: string[];
  postMessageHandlers: number;
  postMessageCalls: number;
  sinks: Record<string, number>;
};

export type JsReconFindings = JsReconExtraction & {
  host: string;
  generatedAt: string;
  bundlesScanned: number;
  sourceMapsScanned: number;
  sourceMaps: string[];
  sourceMapsBlocked: string[];
  sourceMapsFetched: string[];
  sourceMapsInline: string[];
  sourceModules: string[];
  truncated: boolean;
};

const STRING_LITERAL =
  /"((?:[^"\\]|\\.){1,300})"|'((?:[^'\\]|\\.){1,300})'|`((?:[^`\\]|\\.){1,300})`/g;

export const DEFAULT_ACTIVE_FETCH_DELAY_MS = 2_000;

// Caller-controlled delay between live source-map fetches. Missing or
// invalid values fall back to the default; 0 disables throttling explicitly.
export const normalizeThrottleMs = (value: unknown): number => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_ACTIVE_FETCH_DELAY_MS;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_ACTIVE_FETCH_DELAY_MS;
  }
  return Math.floor(parsed);
};
const TEMPLATE_EXPR = /\$\{[^}]*\}/g;
const ABSOLUTE_URL = /^https?:\/\/\S+$/i;
const PATH_LIKE = /^\/[A-Za-z0-9._~!$&()*+,;=:@%/-]+$/;
const GRAPHQL_OPERATION =
  /\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[({]/g;
const STORAGE_ACCESS =
  /\b(?:local|session)Storage\.(?:getItem|setItem|removeItem)\(\s*["'`]([^"'`]{1,100})["'`]/g;
const MESSAGE_LISTENER =
  /\baddEventListener\(\s*["']message["']|\.onmessage\s*=/g;
const POST_MESSAGE_CALL = /\b[\w.$]+\.postMessage\s*\(/g;

const SINK_PATTERNS: Record<string, RegExp> = {
  dangerouslySetInnerHTML: /\bdangerouslySetInnerHTML\b/g,
  "document.write": /\bdocument\.write(?:ln)?\s*\(/g,
  eval: /\beval\s*\(/g,
  innerHTML: /\.innerHTML\s*=/g,
  insertAdjacentHTML: /\.insertAdjacentHTML\s*\(/g,
  "new Function": /\bnew Function\s*\(/g,
  outerHTML: /\.outerHTML\s*=/g,
};

const countMatches = (source: string, pattern: RegExp): number =>
  source.match(pattern)?.length ?? 0;

// Endpoints with no recon value: static assets, bundler dev-server internals,
// and XML-namespace/telemetry hosts. Deliberately kept: .json/.xml/.txt paths,
// localhost URLs, and third-party URLs that are not known noise.
const DROPPED_ENDPOINT_EXTENSION =
  /\.(?:css|map|m?js|png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|webm|mov|wav|ogg|flac|pdf|zip|gz|tgz|tar|wasm)$/i;

const DROPPED_ENDPOINT_HOSTS = new Set([
  "analytics.google.com",
  "bat.bing.com",
  "connect.facebook.net",
  "schema.org",
  "schemas.xmlsoap.org",
  "w3.org",
  "www.google-analytics.com",
  "www.googletagmanager.com",
  "www.w3.org",
]);

const DROPPED_ENDPOINT_HOST_SUFFIXES = [".ingest.sentry.io"];

const DROPPED_ENDPOINT_SEGMENTS = [
  "/@fs/",
  "/@react-refresh",
  "/@vite/",
  "/node_modules/",
];

// Regex instead of `new URL()` — the backend runtime (QuickJS) has no URL.
const ABSOLUTE_URL_HOST = /^https?:\/\/([^/:?#]+)/i;

const shouldDropEndpoint = (value: string): boolean => {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  if (DROPPED_ENDPOINT_EXTENSION.test(withoutQuery)) return true;
  for (const segment of DROPPED_ENDPOINT_SEGMENTS) {
    if (value.includes(segment)) return true;
  }
  const host = ABSOLUTE_URL_HOST.exec(value)?.[1]?.toLowerCase();
  if (host !== undefined) {
    if (DROPPED_ENDPOINT_HOSTS.has(host)) return true;
    if (DROPPED_ENDPOINT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)))
      return true;
  }
  return false;
};

export const extractJsRecon = (source: string): JsReconExtraction => {
  const endpoints = new Set<string>();
  const graphqlOperations = new Set<string>();
  const storageKeys = new Set<string>();

  for (const match of source.matchAll(STRING_LITERAL)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value.length < 2) continue;
    if (shouldDropEndpoint(value)) continue;
    // Template literals carry ${...} interpolations, which PATH_LIKE and
    // ABSOLUTE_URL reject; test the static shape but keep the original so
    // parameter positions stay visible.
    const testable =
      match[3] !== undefined ? value.replace(TEMPLATE_EXPR, "") : value;
    if (PATH_LIKE.test(testable) && !testable.startsWith("//")) {
      endpoints.add(value);
    } else if (ABSOLUTE_URL.test(testable)) {
      endpoints.add(value);
    }
  }

  for (const match of source.matchAll(GRAPHQL_OPERATION)) {
    const operation = match[2];
    if (operation !== undefined) graphqlOperations.add(operation);
  }

  for (const match of source.matchAll(STORAGE_ACCESS)) {
    const key = match[1];
    if (key !== undefined) storageKeys.add(key);
  }

  const sinks: Record<string, number> = {};
  for (const [sink, pattern] of Object.entries(SINK_PATTERNS)) {
    const count = countMatches(source, pattern);
    if (count > 0) sinks[sink] = count;
  }

  return {
    endpoints: [...endpoints].sort(),
    graphqlOperations: [...graphqlOperations].sort(),
    storageKeys: [...storageKeys].sort(),
    postMessageHandlers: countMatches(source, MESSAGE_LISTENER),
    postMessageCalls: countMatches(source, POST_MESSAGE_CALL),
    sinks,
  };
};

export const mergeJsRecon = (
  extractions: readonly JsReconExtraction[],
): JsReconExtraction => {
  const endpoints = new Set<string>();
  const graphqlOperations = new Set<string>();
  const storageKeys = new Set<string>();
  const sinks = new Map<string, number>();
  let postMessageHandlers = 0;
  let postMessageCalls = 0;

  for (const extraction of extractions) {
    for (const endpoint of extraction.endpoints) {
      // Re-filter in case a caller merges extractions produced before the
      // drop list existed.
      if (!shouldDropEndpoint(endpoint)) endpoints.add(endpoint);
    }
    for (const operation of extraction.graphqlOperations)
      graphqlOperations.add(operation);
    for (const key of extraction.storageKeys) storageKeys.add(key);
    postMessageHandlers += extraction.postMessageHandlers;
    postMessageCalls += extraction.postMessageCalls;
    for (const [sink, count] of Object.entries(extraction.sinks)) {
      sinks.set(sink, (sinks.get(sink) ?? 0) + count);
    }
  }

  return {
    endpoints: [...endpoints].sort(),
    graphqlOperations: [...graphqlOperations].sort(),
    storageKeys: [...storageKeys].sort(),
    postMessageHandlers,
    postMessageCalls,
    sinks: Object.fromEntries(
      [...sinks.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
};

export type SourceMapRecon = {
  // Module paths from the map's `sources` array — the original module tree.
  sources: string[];
  // Extraction over the map's `sourcesContent` (original, unminified source).
  extraction: JsReconExtraction;
};

export const extractSourceMapRecon = (
  text: string,
): SourceMapRecon | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as { sources?: unknown; sourcesContent?: unknown };
  if (!Array.isArray(candidate.sources)) return undefined;

  const sources = new Set<string>();
  for (const source of candidate.sources) {
    if (typeof source === "string" && source.length > 0) sources.add(source);
  }

  const extractions: JsReconExtraction[] = [];
  if (Array.isArray(candidate.sourcesContent)) {
    for (const content of candidate.sourcesContent) {
      if (typeof content === "string" && content.length > 0) {
        extractions.push(extractJsRecon(content));
      }
    }
  }

  return {
    sources: [...sources].sort(),
    extraction: mergeJsRecon(extractions),
  };
};

const SOURCEMAP_REFERENCE = /\/\/# sourceMappingURL=(\S+)/g;

// The spec's winning reference is the last one in the file.
export const findSourceMapRef = (source: string): string | undefined => {
  let found: string | undefined;
  for (const match of source.matchAll(SOURCEMAP_REFERENCE)) {
    found = match[1];
  }
  return found;
};
