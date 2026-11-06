export type JsReconEvidence = {
  kind:
    | "endpoint"
    | "graphql-operation"
    | "storage-key"
    | "sink"
    | "post-message-handler"
    | "post-message-call";
  value: string;
  assetPath?: string;
  sourcePath?: string;
  requestId?: string;
  line: number;
  column: number;
};

export type JsReconOrigin = Pick<
  JsReconEvidence,
  "assetPath" | "sourcePath" | "requestId"
>;

export type JsReconExtraction = {
  endpoints: string[];
  graphqlOperations: string[];
  storageKeys: string[];
  postMessageHandlers: number;
  postMessageCalls: number;
  sinks: Record<string, number>;
  evidence: JsReconEvidence[];
};

export type JsReconActiveOptions = {
  delayMs: number;
  maxRequests?: number;
};

export type JsReconScanOptions = {
  active?: JsReconActiveOptions;
};

export type JsReconActiveSummary = {
  runId: string;
  requestsSent: number;
  requestBudget: number | "all";
  delayMs: number;
  budgetExhausted: boolean;
  skippedOutOfScope: number;
  failedRequests: number;
};

export type JsReconFindings = JsReconExtraction & {
  host: string;
  generatedAt: string;
  bundlesScanned: number;
  sourceMapsScanned: number;
  missingMapReferences: number;
  sourceMaps: string[];
  sourceMapsBlocked: string[];
  sourceMapsFetched: string[];
  sourceMapsInline: string[];
  sourceModules: string[];
  truncated: boolean;
  activeRecon?: JsReconActiveSummary;
};

const STRING_LITERAL =
  /"((?:[^"\\]|\\.){1,300})"|'((?:[^'\\]|\\.){1,300})'|`((?:[^`\\]|\\.){1,300})`/g;

export const DEFAULT_CAPPED_REQUEST_BUDGET = 10;
export const MAX_ACTIVE_REQUEST_BUDGET = 20;
export const MIN_ACTIVE_FETCH_DELAY_MS = 1_000;
export const DEFAULT_ACTIVE_FETCH_DELAY_MS = 2_000;
export const MAX_ACTIVE_FETCH_DELAY_MS = 60_000;

export const validateActiveReconOptions = (
  value: unknown,
): string | undefined => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "maxRequests" && key !== "delayMs")
  ) {
    return "Active recon requires a delay in milliseconds and an optional request budget.";
  }
  const { maxRequests, delayMs } = value as Partial<JsReconActiveOptions>;
  if (
    "maxRequests" in value &&
    (typeof maxRequests !== "number" ||
      !Number.isInteger(maxRequests) ||
      maxRequests < 1 ||
      maxRequests > MAX_ACTIVE_REQUEST_BUDGET)
  ) {
    return `Request budget must be a whole number from 1 to ${MAX_ACTIVE_REQUEST_BUDGET}.`;
  }
  if (
    typeof delayMs !== "number" ||
    !Number.isInteger(delayMs) ||
    delayMs < MIN_ACTIVE_FETCH_DELAY_MS ||
    delayMs > MAX_ACTIVE_FETCH_DELAY_MS
  ) {
    return `Fetch delay must be a whole number from ${MIN_ACTIVE_FETCH_DELAY_MS} to ${MAX_ACTIVE_FETCH_DELAY_MS} milliseconds.`;
  }
  return undefined;
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

// Prefer original modules to bundled code, then choose a stable representative
// independent of candidate fetch order and source-map iteration order.
const compareText = (
  left: string | undefined,
  right: string | undefined,
): number => {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left < right ? -1 : 1;
};

const compareEvidence = (
  left: JsReconEvidence,
  right: JsReconEvidence,
): number =>
  Number(right.sourcePath !== undefined) -
    Number(left.sourcePath !== undefined) ||
  compareText(left.sourcePath, right.sourcePath) ||
  compareText(left.assetPath, right.assetPath) ||
  compareText(left.requestId, right.requestId) ||
  left.line - right.line ||
  left.column - right.column;

const addEvidence = (
  representatives: Map<string, JsReconEvidence>,
  evidence: JsReconEvidence,
): void => {
  const key = `${evidence.kind}\0${evidence.value}`;
  const previous = representatives.get(key);
  if (previous === undefined || compareEvidence(evidence, previous) < 0) {
    representatives.set(key, evidence);
  }
};

const sortedEvidence = (
  representatives: Map<string, JsReconEvidence>,
): JsReconEvidence[] =>
  [...representatives.values()].sort(
    (left, right) =>
      compareText(left.kind, right.kind) ||
      compareText(left.value, right.value),
  );

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

export const extractJsRecon = (
  source: string,
  origin: JsReconOrigin = {},
): JsReconExtraction => {
  const endpoints = new Set<string>();
  const graphqlOperations = new Set<string>();
  const storageKeys = new Set<string>();
  const representatives = new Map<string, JsReconEvidence>();
  let lineStarts: number[] | undefined;

  const record = (
    kind: JsReconEvidence["kind"],
    value: string,
    index: number,
  ): void => {
    // Each pattern is traversed in source order, so the first occurrence is
    // the representative for a kind/value within this one asset.
    const key = `${kind}\0${value}`;
    if (representatives.has(key)) return;
    if (lineStarts === undefined) {
      lineStarts = [0];
      for (let position = 0; position < source.length; position += 1) {
        if (source.charCodeAt(position) === 10) lineStarts.push(position + 1);
      }
    }
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle]! <= index) low = middle + 1;
      else high = middle;
    }
    const lineIndex = low - 1;
    representatives.set(key, {
      kind,
      value,
      ...origin,
      line: lineIndex + 1,
      column: index - lineStarts[lineIndex]! + 1,
    });
  };

  for (const match of source.matchAll(STRING_LITERAL)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value.length < 2) continue;
    if (shouldDropEndpoint(value)) continue;
    // Template literals carry ${...} interpolations, which PATH_LIKE and
    // ABSOLUTE_URL reject; test the static shape but keep the original so
    // parameter positions stay visible.
    const testable =
      match[3] !== undefined ? value.replace(TEMPLATE_EXPR, "") : value;
    if (
      (PATH_LIKE.test(testable) && !testable.startsWith("//")) ||
      ABSOLUTE_URL.test(testable)
    ) {
      endpoints.add(value);
      record("endpoint", value, match.index + 1);
    }
  }

  for (const match of source.matchAll(GRAPHQL_OPERATION)) {
    const operation = match[2];
    if (operation !== undefined) {
      graphqlOperations.add(operation);
      record("graphql-operation", operation, match.index);
    }
  }

  for (const match of source.matchAll(STORAGE_ACCESS)) {
    const key = match[1];
    if (key !== undefined) {
      storageKeys.add(key);
      record(
        "storage-key",
        key,
        match.index + match[0].length - key.length - 1,
      );
    }
  }

  const sinks: Record<string, number> = {};
  for (const [sink, pattern] of Object.entries(SINK_PATTERNS)) {
    let count = 0;
    for (const match of source.matchAll(pattern)) {
      count += 1;
      record("sink", sink, match.index);
    }
    if (count > 0) sinks[sink] = count;
  }

  let postMessageHandlers = 0;
  for (const match of source.matchAll(MESSAGE_LISTENER)) {
    postMessageHandlers += 1;
    record("post-message-handler", "message", match.index);
  }
  let postMessageCalls = 0;
  for (const match of source.matchAll(POST_MESSAGE_CALL)) {
    postMessageCalls += 1;
    record("post-message-call", "postMessage", match.index);
  }

  return {
    endpoints: [...endpoints].sort(),
    graphqlOperations: [...graphqlOperations].sort(),
    storageKeys: [...storageKeys].sort(),
    postMessageHandlers,
    postMessageCalls,
    sinks,
    evidence: sortedEvidence(representatives),
  };
};

export const mergeJsRecon = (
  extractions: readonly JsReconExtraction[],
): JsReconExtraction => {
  const endpoints = new Set<string>();
  const graphqlOperations = new Set<string>();
  const storageKeys = new Set<string>();
  const sinks = new Map<string, number>();
  const representatives = new Map<string, JsReconEvidence>();
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
    for (const evidence of extraction.evidence) {
      if (evidence.kind === "endpoint" && shouldDropEndpoint(evidence.value))
        continue;
      addEvidence(representatives, evidence);
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
    evidence: sortedEvidence(representatives),
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
  origin: JsReconOrigin = {},
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
    for (const [index, content] of candidate.sourcesContent.entries()) {
      if (typeof content === "string" && content.length > 0) {
        const sourcePath = candidate.sources[index];
        extractions.push(
          extractJsRecon(content, {
            ...origin,
            ...(typeof sourcePath === "string" && sourcePath.length > 0
              ? { sourcePath }
              : {}),
          }),
        );
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
