export type ApiMapRequest = {
  path: string;
  query: string;
  method: string;
  statusCode?: number;
  seenAt?: string;
};

export type ApiRoute = {
  template: string;
  examplePath: string;
  inSitemap: boolean;
  requests: number;
  methods: Record<string, number>;
  statuses: Record<string, number>;
  queryKeys: readonly string[];
  firstSeen?: string;
  lastSeen?: string;
};

export type SegmentParamKind = "numeric" | "uuid" | "ulid" | "date" | "token";

const CARDINALITY_THRESHOLD = 5;
const PARAM_ID = "{id}";
const PARAM_ANY = "{param}";

const isParam = (segment: string): boolean =>
  segment === PARAM_ID || segment === PARAM_ANY;

export const segmentParamKind = (
  segment: string,
): SegmentParamKind | undefined => {
  if (/^\d+$/.test(segment)) return "numeric";
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      segment,
    )
  )
    return "uuid";
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(segment)) return "ulid";
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(segment))
    return "date";
  if (
    segment.length >= 16 &&
    /\d/.test(segment) &&
    /^[A-Za-z0-9_-]+$/.test(segment)
  )
    return "token";
  return undefined;
};

const queryKeysOf = (query: string): string[] => {
  const keys = new Set<string>();
  for (const pair of query.split("&")) {
    if (pair.length === 0) continue;
    const key = pair.split("=", 1)[0];
    if (key !== undefined && key.length > 0) keys.add(key);
  }
  return [...keys].sort();
};

const segmentsOf = (path: string): string[] =>
  path.split("/").filter((segment) => segment.length > 0);

const patternCollapse = (path: string): string[] =>
  segmentsOf(path).map((segment) =>
    segmentParamKind(segment) === undefined ? segment : PARAM_ID,
  );

const cardinalityCollapse = (segmentLists: string[][]): string[][] => {
  const collapse = new Set<string>();
  const maxLength = segmentLists.reduce(
    (maximum, segments) => Math.max(maximum, segments.length),
    0,
  );
  for (let position = 0; position < maxLength; position += 1) {
    const groups = new Map<string, number[]>();
    segmentLists.forEach((segments, index) => {
      if (position >= segments.length) return;
      if (isParam(segments[position] ?? "")) return;
      const key = segments
        .map((segment, at) => (at === position ? "" : segment))
        .join("/");
      const group = groups.get(key) ?? [];
      group.push(index);
      groups.set(key, group);
    });
    for (const group of groups.values()) {
      const distinct = new Set(
        group.map((index) => segmentLists[index]?.[position] ?? ""),
      );
      if (distinct.size > CARDINALITY_THRESHOLD) {
        for (const index of group) collapse.add(`${index}:${position}`);
      }
    }
  }
  return segmentLists.map((segments, index) =>
    segments.map((segment, at) =>
      collapse.has(`${index}:${at}`) ? PARAM_ANY : segment,
    ),
  );
};

type TemplateIndex = {
  byExactPath: Map<string, string>;
  examplePaths: Map<string, string>;
  templates: { segments: string[]; template: string }[];
};

const buildTemplateIndex = (paths: readonly string[]): TemplateIndex => {
  const patternCollapsed = paths.map(patternCollapse);
  const fullyCollapsed = cardinalityCollapse(patternCollapsed);
  const byExactPath = new Map<string, string>();
  const examplePaths = new Map<string, string>();
  const templates = new Map<string, string[]>();

  fullyCollapsed.forEach((segments, index) => {
    const path = paths[index];
    if (path === undefined) return;
    const template = `/${segments.join("/")}`;
    byExactPath.set(`/${patternCollapsed[index]?.join("/") ?? ""}`, template);
    const example = examplePaths.get(template);
    if (example === undefined || path < example)
      examplePaths.set(template, path);
    if (!templates.has(template)) templates.set(template, segments);
  });

  return {
    byExactPath,
    examplePaths,
    templates: [...templates.entries()]
      .map(([template, segments]) => ({ segments, template }))
      .sort((left, right) => left.template.localeCompare(right.template)),
  };
};

const matchTemplate = (
  path: string,
  index: TemplateIndex,
): string | undefined => {
  const collapsed = patternCollapse(path);
  const exact = index.byExactPath.get(`/${collapsed.join("/")}`);
  if (exact !== undefined) return exact;

  let best: { template: string; params: number } | undefined;
  for (const candidate of index.templates) {
    if (candidate.segments.length !== collapsed.length) continue;
    let params = 0;
    let matches = true;
    for (let at = 0; at < collapsed.length; at += 1) {
      const wanted = candidate.segments[at] ?? "";
      if (isParam(wanted)) {
        params += 1;
        continue;
      }
      if (wanted !== collapsed[at]) {
        matches = false;
        break;
      }
    }
    if (matches && (best === undefined || params < best.params)) {
      best = { template: candidate.template, params };
    }
  }
  return best?.template;
};

const sortedRecord = (map: Map<string, number>): Record<string, number> =>
  Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );

export const buildApiMap = (
  sitemapPaths: readonly string[],
  requests: ApiMapRequest[],
): ApiRoute[] => {
  const index = buildTemplateIndex(sitemapPaths);

  type Aggregate = {
    examplePath: string;
    inSitemap: boolean;
    requests: number;
    methods: Map<string, number>;
    statuses: Map<string, number>;
    queryKeySet: Set<string>;
    firstSeen?: string;
    lastSeen?: string;
  };

  const aggregates = new Map<string, Aggregate>();
  const aggregateFor = (template: string, inSitemap: boolean): Aggregate => {
    let aggregate = aggregates.get(template);
    if (aggregate === undefined) {
      aggregate = {
        examplePath: index.examplePaths.get(template) ?? template,
        inSitemap,
        requests: 0,
        methods: new Map(),
        statuses: new Map(),
        queryKeySet: new Set(),
      };
      aggregates.set(template, aggregate);
    }
    return aggregate;
  };

  for (const { template } of index.templates) aggregateFor(template, true);

  const matched = requests.map((request) => ({
    request,
    template: matchTemplate(request.path, index),
  }));

  matched.forEach(({ request, template }) => {
    const key = template ?? `/${patternCollapse(request.path).join("/")}`;
    const aggregate = aggregateFor(key, template !== undefined);
    aggregate.requests += 1;
    if (aggregate.examplePath === key || request.path < aggregate.examplePath)
      aggregate.examplePath = request.path;
    const method = request.method.toUpperCase();
    aggregate.methods.set(method, (aggregate.methods.get(method) ?? 0) + 1);
    if (request.statusCode !== undefined) {
      const status = String(request.statusCode);
      aggregate.statuses.set(status, (aggregate.statuses.get(status) ?? 0) + 1);
    }
    for (const key2 of queryKeysOf(request.query))
      aggregate.queryKeySet.add(key2);
    if (request.seenAt !== undefined) {
      if (
        aggregate.firstSeen === undefined ||
        request.seenAt < aggregate.firstSeen
      )
        aggregate.firstSeen = request.seenAt;
      if (
        aggregate.lastSeen === undefined ||
        request.seenAt > aggregate.lastSeen
      )
        aggregate.lastSeen = request.seenAt;
    }
  });

  return [...aggregates.entries()]
    .map(([template, aggregate]) => {
      const route: ApiRoute = {
        template,
        examplePath: aggregate.examplePath,
        inSitemap: aggregate.inSitemap,
        requests: aggregate.requests,
        methods: sortedRecord(aggregate.methods),
        statuses: sortedRecord(aggregate.statuses),
        queryKeys: [...aggregate.queryKeySet].sort(),
      };
      if (aggregate.firstSeen !== undefined)
        route.firstSeen = aggregate.firstSeen;
      if (aggregate.lastSeen !== undefined) route.lastSeen = aggregate.lastSeen;
      return route;
    })
    .sort((left, right) => left.template.localeCompare(right.template));
};
