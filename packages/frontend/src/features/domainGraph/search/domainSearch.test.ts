import { describe, expect, it } from "vitest";

import { rankDomainMatches } from "./domainSearch";

const HOSTS = [
  "example.com",
  "stage.example.com",
  "api.stage.example.com",
  "static.stage.example.com",
  "staging.other.com",
  "other.com",
];

describe("rankDomainMatches", () => {
  it("returns nothing for an empty or blank query", () => {
    expect(rankDomainMatches(HOSTS, "")).toEqual([]);
    expect(rankDomainMatches(HOSTS, "   ")).toEqual([]);
  });

  it("ranks exact, then prefix, then substring, alphabetical within groups", () => {
    expect(rankDomainMatches(HOSTS, "stage.example.com")).toEqual([
      "stage.example.com",
      "api.stage.example.com",
      "static.stage.example.com",
    ]);
    expect(rankDomainMatches(HOSTS, "stage")).toEqual([
      "stage.example.com",
      "api.stage.example.com",
      "static.stage.example.com",
    ]);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(rankDomainMatches(HOSTS, "  EXAMPLE.COM ")).toEqual([
      "example.com",
      "api.stage.example.com",
      "stage.example.com",
      "static.stage.example.com",
    ]);
  });

  it("caps results at 25", () => {
    const many = Array.from({ length: 40 }, (_, i) => `h${i}.example.com`);
    expect(rankDomainMatches(many, "example.com")).toHaveLength(25);
  });

  it("returns no matches for unknown text", () => {
    expect(rankDomainMatches(HOSTS, "zzz")).toEqual([]);
  });
});
