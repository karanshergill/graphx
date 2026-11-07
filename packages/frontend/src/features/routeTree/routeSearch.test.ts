import type { ApiRoute } from "shared";
import { describe, expect, it } from "vitest";

import { indexRouteSearch, searchRouteIndex } from "./routeSearch";

const route = (template: string, examplePath = template): ApiRoute => ({
  template,
  examplePath,
  requests: 0,
  inSitemap: true,
  methods: {},
  statuses: {},
  queryKeys: [],
  evidence: [],
});

describe("API route search", () => {
  it("finds a parameterized route by its template or concrete example path", () => {
    const index = indexRouteSearch([
      route("/orders/{id}", "/orders/42"),
      route("/health"),
    ]);
    for (const query of ["/orders/{id}", "/orders/42", "  /ORDERS/42  "])
      expect(
        searchRouteIndex(index, query).map(({ template }) => template),
      ).toEqual(["/orders/{id}"]);
  });

  it("ranks exact, prefix, and substring matches across both fields", () => {
    const routes = [
      route("/archive/orders/42"),
      route("/orders/42b"),
      route("/orders/{id}", "/orders/42"),
      route("/orders/42a"),
    ];
    const expected = [
      "/orders/{id}",
      "/orders/42a",
      "/orders/42b",
      "/archive/orders/42",
    ];
    expect(
      searchRouteIndex(indexRouteSearch(routes), "/orders/42").map(
        ({ template }) => template,
      ),
    ).toEqual(expected);
    expect(
      searchRouteIndex(
        indexRouteSearch([...routes].reverse()),
        "/orders/42",
      ).map(({ template }) => template),
    ).toEqual(expected);
  });

  it("keeps the best 25 matches rather than dropping an exact result", () => {
    const prefixes = Array.from({ length: 30 }, (_, index) =>
      route(`/api/route${String(index).padStart(2, "0")}`),
    );
    const index = indexRouteSearch([...prefixes, route("/api/route")]);
    expect(
      searchRouteIndex(index, "/api/route").map(({ template }) => template),
    ).toEqual([
      "/api/route",
      ...prefixes.slice(0, 24).map(({ template }) => template),
    ]);
  });

  it.each(["", "   ", "/not-captured"])("has no matches for %j", (query) => {
    expect(
      searchRouteIndex(indexRouteSearch([route("/health")]), query),
    ).toEqual([]);
  });
});
