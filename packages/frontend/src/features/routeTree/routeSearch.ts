import type { ApiRoute } from "shared";

type RouteSearchEntry = {
  route: ApiRoute;
  template: string;
  examplePath: string;
};

const MAX_MATCHES = 25;

export const indexRouteSearch = (
  routes: readonly ApiRoute[],
): RouteSearchEntry[] =>
  routes
    .map((route) => ({
      route,
      template: route.template.toLowerCase(),
      examplePath: route.examplePath.toLowerCase(),
    }))
    .sort((left, right) =>
      left.route.template.localeCompare(right.route.template),
    );

export const searchRouteIndex = (
  index: readonly RouteSearchEntry[],
  query: string,
): ApiRoute[] => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const exact: ApiRoute[] = [];
  const prefix: ApiRoute[] = [];
  const substring: ApiRoute[] = [];
  for (const entry of index) {
    const { template, examplePath } = entry;
    const matches =
      template === needle || examplePath === needle
        ? exact
        : template.startsWith(needle) || examplePath.startsWith(needle)
          ? prefix
          : template.includes(needle) || examplePath.includes(needle)
            ? substring
            : undefined;
    if (matches !== undefined && matches.length < MAX_MATCHES)
      matches.push(entry.route);
  }
  return [...exact, ...prefix, ...substring].slice(0, MAX_MATCHES);
};
