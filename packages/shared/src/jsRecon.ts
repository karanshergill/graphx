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
  truncated: boolean;
};

const MAX_ENDPOINTS = 200;
const MAX_GRAPHQL_OPERATIONS = 100;
const MAX_STORAGE_KEYS = 100;

const STRING_LITERAL = /"((?:[^"\\]|\\.){1,300})"|'((?:[^'\\]|\\.){1,300})'/g;
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
    const value = match[1] ?? match[2] ?? "";
    if (value.length < 2) continue;
    if (shouldDropEndpoint(value)) continue;
    if (PATH_LIKE.test(value) && !value.startsWith("//")) {
      endpoints.add(value);
    } else if (ABSOLUTE_URL.test(value)) {
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
    endpoints: [...endpoints].sort().slice(0, MAX_ENDPOINTS),
    graphqlOperations: [...graphqlOperations]
      .sort()
      .slice(0, MAX_GRAPHQL_OPERATIONS),
    storageKeys: [...storageKeys].sort().slice(0, MAX_STORAGE_KEYS),
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
    endpoints: [...endpoints].sort().slice(0, MAX_ENDPOINTS),
    graphqlOperations: [...graphqlOperations]
      .sort()
      .slice(0, MAX_GRAPHQL_OPERATIONS),
    storageKeys: [...storageKeys].sort().slice(0, MAX_STORAGE_KEYS),
    postMessageHandlers,
    postMessageCalls,
    sinks: Object.fromEntries(
      [...sinks.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
};
