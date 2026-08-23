import { normalizeHostname } from "./hostname";
import type { ScopeDefinition } from "./types";

const normalizePattern = (input: string): string | undefined => {
  const pattern = input.trim().toLowerCase().replace(/\.+$/, "");
  if (pattern.length === 0 || !/^[a-z0-9.*?_-]+$/.test(pattern)) {
    return undefined;
  }
  return pattern;
};

const compilePattern = (input: string): RegExp | undefined => {
  const pattern = normalizePattern(input);
  if (pattern === undefined) return undefined;

  const expression = Array.from(pattern, (character) => {
    if (character === "*") return ".*";
    if (character === "?") return ".";
    if ("\\^$+.()|{}[]".includes(character)) return `\\${character}`;
    return character;
  }).join("");

  return new RegExp(`^${expression}$`, "i");
};

export const createScopeMatcher = (
  scope: ScopeDefinition,
): ((input: string) => boolean) => {
  const allowlist = scope.allowlist
    .map(compilePattern)
    .filter((pattern): pattern is RegExp => pattern !== undefined);
  const denylist = scope.denylist
    .map(compilePattern)
    .filter((pattern): pattern is RegExp => pattern !== undefined);

  return (input: string): boolean => {
    const hostname = normalizeHostname(input);
    if (hostname === undefined) return false;
    if (denylist.some((pattern) => pattern.test(hostname))) return false;
    return allowlist.some((pattern) => pattern.test(hostname));
  };
};
