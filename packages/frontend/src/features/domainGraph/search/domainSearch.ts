const MAX_MATCHES = 25;

export const rankDomainMatches = (
  hostnames: readonly string[],
  query: string,
): string[] => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const exact: string[] = [];
  const prefix: string[] = [];
  const substring: string[] = [];

  for (const hostname of hostnames) {
    const candidate = hostname.toLowerCase();
    if (candidate === needle) exact.push(hostname);
    else if (candidate.startsWith(needle)) prefix.push(hostname);
    else if (candidate.includes(needle)) substring.push(hostname);
  }

  const byName = (left: string, right: string) => left.localeCompare(right);
  return [
    ...exact.sort(byName),
    ...prefix.sort(byName),
    ...substring.sort(byName),
  ].slice(0, MAX_MATCHES);
};
