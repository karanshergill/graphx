import { Buffer } from "buffer";
import { DatabaseSync } from "node:sqlite";

import type { JsReconScanOptions } from "shared";
import { describe, expect, it, type Mock, vi } from "vitest";

import { createAgentRoutes } from "../agentapi/routes";
import { createJsReconApi } from "../api/jsRecon";
import {
  createJsReconRepository,
  type JsReconAuditEvent,
  type JsReconRepository,
} from "../repositories/jsRecon";
import type { BackendSDK } from "../types";

import { createJsReconService } from "./jsRecon";

vi.mock("caido:utils", () => ({
  RequestSpec: class {
    constructor(readonly url: string) {}
  },
}));

type Fixture = {
  sdk: BackendSDK;
  send: Mock;
  setProject: (id: string) => void;
  setScope: (id: string) => void;
  requestedPages: { filter: string; first: number }[];
};

const fixture = (
  bundles: number,
  options: {
    reference?: (index: number) => string;
    bundleLocation?: (index: number) => {
      path: string;
      isTls?: boolean;
      port?: number;
    };
    observedMaps?: {
      path: string;
      query?: string;
      body?: string;
      isTls?: boolean;
      port?: number;
    }[];
    blockedMaps?: {
      path: string;
      query?: string;
      isTls?: boolean;
      port?: number;
    }[];
    responseOverrides?: Record<
      string,
      { statusCode: number; body: string; headers?: string[] }
    >;
    pagination?: (
      page: number,
      after?: string,
    ) => "repeat" | "empty" | "missing" | undefined;
  } = {},
): Fixture => {
  let page = 0;
  let projectId = "project-a";
  let scopeId = "scope-a";
  const requestedPages: Fixture["requestedPages"] = [];
  const send = vi.fn(() =>
    Promise.resolve({
      response: { getCode: () => 404, getBody: () => undefined },
    }),
  );
  const sdk = {
    projects: {
      getCurrent: () =>
        Promise.resolve({
          getId: () => projectId,
          getName: () => projectId,
        }),
    },
    graphql: {
      execute: (query: string, variables: Record<string, unknown>) => {
        if (query.includes("scopes {")) {
          return Promise.resolve({
            data: {
              scopes: [
                { id: scopeId, name: scopeId, allowlist: [], denylist: [] },
              ],
            },
          });
        }
        if (query.includes("request(id:")) {
          if (typeof variables.id !== "string")
            throw new Error("Expected captured request ID.");
          const index = Number(variables.id.slice(1));
          const map = variables.id.startsWith("m")
            ? options.observedMaps?.[index]
            : undefined;
          const override = options.responseOverrides?.[variables.id];
          const body =
            override?.body ??
            (map === undefined
              ? `//# sourceMappingURL=${options.reference?.(index) ?? `/bundle${index}.js.map`}`
              : (map.body ??
                '{"version":3,"sources":["original.ts"],"mappings":""}'));
          const headers = override?.headers?.join("\r\n");
          const raw = `HTTP/1.1 ${override?.statusCode ?? 200} ${override?.statusCode === 304 ? "Not Modified" : "OK"}\r\n${headers === undefined || headers === "" ? "" : `${headers}\r\n`}\r\n${body}`;
          return Promise.resolve({
            data: {
              request: {
                response: {
                  raw: Buffer.from(raw).toString("base64"),
                },
              },
            },
          });
        }
        const filterInput = variables.filter;
        if (
          typeof filterInput !== "object" ||
          filterInput === null ||
          !("code" in filterInput) ||
          typeof filterInput.code !== "string" ||
          typeof variables.first !== "number"
        ) {
          throw new Error("Expected filtered candidate query.");
        }
        const filter = filterInput.code;
        const first = variables.first;
        requestedPages.push({ filter, first });
        const isJs = filter.includes('req.path.like:"%.js"');
        const isBlocked = filter.includes("resp.code.gte:400");
        const offset =
          typeof variables.after === "string"
            ? Number(variables.after.slice(1)) + 1
            : 0;
        const count = isJs
          ? bundles
          : isBlocked
            ? (options.blockedMaps?.length ?? 0)
            : (options.observedMaps?.length ?? 0);
        const edges = Array.from(
          { length: Math.min(first, count - offset) },
          (_, index) => {
            const current = offset + index;
            const map = isJs
              ? undefined
              : (isBlocked ? options.blockedMaps : options.observedMaps)?.[
                  current
                ];
            const id = `${isJs ? "r" : isBlocked ? "b" : "m"}${current}`;
            return {
              cursor: `c${current}`,
              node: {
                id,
                path: map?.path ?? `/bundle${current}.js`,
                ...(map?.query === undefined ? {} : { query: map.query }),
                isTls: map?.isTls ?? true,
                ...(map?.port === undefined ? {} : { port: map.port }),
                ...(isJs ? (options.bundleLocation?.(current) ?? {}) : {}),
                response: {
                  statusCode:
                    options.responseOverrides?.[id]?.statusCode ??
                    (isBlocked ? 403 : 200),
                },
              },
            };
          },
        );
        const next = offset + edges.length;
        const pagination = isJs
          ? options.pagination?.(page++, variables.after as string | undefined)
          : undefined;
        return Promise.resolve({
          data: {
            requests: {
              edges: pagination === "empty" ? [] : edges,
              pageInfo: {
                hasNextPage: pagination === undefined ? next < count : true,
                endCursor:
                  pagination === "missing"
                    ? undefined
                    : pagination === "repeat"
                      ? (variables.after as string)
                      : edges.at(-1)?.cursor,
              },
            },
          },
        });
      },
    },
    requests: { inScope: vi.fn(() => true), send },
    console: { warn: vi.fn() },
  } as unknown as BackendSDK;
  return {
    sdk,
    send,
    setProject: (id) => {
      projectId = id;
    },
    setScope: (id) => {
      scopeId = id;
    },
    requestedPages,
  };
};

const memoryRepository = () => {
  const events: JsReconAuditEvent[] = [];
  const repo: JsReconRepository = {
    save: vi.fn(() => Promise.resolve()),
    appendAudit: vi.fn((_projectId, event) => {
      events.push(event);
      return Promise.resolve();
    }),
    listAudit: vi.fn((_projectId, scopeId, host) =>
      Promise.resolve(
        events
          .filter((event) => event.scopeId === scopeId && event.host === host)
          .slice(-100)
          .reverse(),
      ),
    ),
  };
  return { events, repo };
};

const active = { active: { maxRequests: 2, delayMs: 1_000 } };
const auditEventsFrom = (body: unknown): readonly unknown[] => {
  if (
    body === null ||
    typeof body !== "object" ||
    !("events" in body) ||
    !Array.isArray(body.events)
  ) {
    throw new Error("Missing audit events.");
  }
  return body.events;
};

describe("JS recon backend safety", () => {
  it("keeps agent GET passive and rejects active/throttle parameters", async () => {
    const { sdk, send } = fixture(2);
    const { repo } = memoryRepository();
    const service = createJsReconService(sdk, repo);
    const route = createAgentRoutes(
      sdk,
      {} as Parameters<typeof createAgentRoutes>[1],
      service,
    ).find((entry) => entry.path === "/js-recon");
    expect(route).toBeDefined();
    for (const extra of [
      "active=true",
      "throttle=0",
      "budget=20",
      "delayMs=1000",
    ]) {
      const result = await route!.handle(
        new URLSearchParams(`host=example.com&${extra}`),
      );
      expect(result.status).toBe(400);
    }
    const result = await route!.handle(new URLSearchParams("host=example.com"));
    expect(result.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({
      missingMapReferences: 2,
      sourceMapsFetched: [],
    });
  });

  it("rejects malformed active options before any audit or scan", async () => {
    const { sdk, send } = fixture(1);
    const { repo } = memoryRepository();
    const service = createJsReconService(sdk, repo);
    for (const invalid of [
      { maxRequests: 0, delayMs: 1_000 },
      { maxRequests: 21, delayMs: 1_000 },
      { maxRequests: 1, delayMs: 0 },
      { maxRequests: 1, delayMs: 1.5 },
    ]) {
      expect(
        (await service.scan("example.com", "scope-a", { active: invalid }))
          .kind,
      ).toBe("Error");
    }
    expect(repo.appendAudit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("enforces the per-run request budget with a complete ordered audit", async () => {
    const { sdk, send } = fixture(3);
    const { events, repo } = memoryRepository();
    send.mockImplementation(() => {
      expect(events.at(-1)?.type).toBe("request");
      return Promise.resolve({
        response: { getCode: () => 404, getBody: () => undefined },
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const running = createJsReconService(sdk, repo).scan(
      "example.com",
      "scope-a",
      active,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await running;
    vi.useRealTimers();
    expect(result.kind).toBe("Ok");
    if (result.kind !== "Ok") return;
    expect(result.value.activeRecon).toMatchObject({
      requestsSent: 2,
      requestBudget: 2,
      delayMs: 1_000,
      failedRequests: 2,
      skippedOutOfScope: 0,
      budgetExhausted: true,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "request",
      "response",
      "request",
      "response",
      "finish",
    ]);
    expect(
      events.every((event) => event.runId === result.value.activeRecon?.runId),
    ).toBe(true);
    expect(events[2]).toMatchObject({ statusCode: 404, outcome: "blocked" });
  });

  it("spaces active sends and rejects concurrent active runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { sdk, send } = fixture(2);
    const { repo } = memoryRepository();
    const sentAt: number[] = [];
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    send
      .mockImplementationOnce(async () => {
        sentAt.push(Date.now());
        firstStarted.resolve();
        await releaseFirst.promise;
        return { response: { getCode: () => 404, getBody: () => undefined } };
      })
      .mockImplementationOnce(() => {
        sentAt.push(Date.now());
        return Promise.resolve({
          response: { getCode: () => 404, getBody: () => undefined },
        });
      });
    const service = createJsReconService(sdk, repo);
    const running = service.scan("example.com", "scope-a", active);
    await vi.advanceTimersByTimeAsync(1_000);
    await firstStarted.promise;
    expect(await service.scan("example.com", "scope-a", active)).toEqual({
      kind: "Error",
      error: "An active JS recon run is already in progress.",
    });
    releaseFirst.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await running).kind).toBe("Ok");
    vi.useRealTimers();
    expect(sentAt).toHaveLength(2);
    expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(1_000);
  });

  it("paces the first send of the next active run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { sdk, send } = fixture(1);
      const { repo } = memoryRepository();
      const sentAt: number[] = [];
      send.mockImplementation(() => {
        sentAt.push(Date.now());
        return Promise.resolve({
          response: { getCode: () => 404, getBody: () => undefined },
        });
      });
      const service = createJsReconService(sdk, repo);
      const firstRun = await service.scan("example.com", "scope-a", active);
      expect(firstRun.kind).toBe("Ok");
      const nextRun = service.scan("example.com", "scope-a", active);
      await vi.runAllTimersAsync();
      const secondRun = await nextRun;
      expect(secondRun.kind).toBe("Ok");
      if (firstRun.kind !== "Ok" || secondRun.kind !== "Ok") return;
      expect(firstRun.value.activeRecon?.runId).not.toBe(
        secondRun.value.activeRecon?.runId,
      );
      expect(sentAt).toHaveLength(2);
      expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends when audit start or pre-send append fails", async () => {
    const { sdk, send } = fixture(1);
    const { repo } = memoryRepository();
    repo.appendAudit = vi.fn(() =>
      Promise.reject(new Error("audit unavailable")),
    );
    const service = createJsReconService(sdk, repo);
    expect((await service.scan("example.com", "scope-a", active)).kind).toBe(
      "Error",
    );
    expect(send).not.toHaveBeenCalled();
    const { repo: requestRepo } = memoryRepository();
    requestRepo.appendAudit = vi.fn((_project, event) => {
      if (event.type === "request")
        return Promise.reject(new Error("audit unavailable"));
      return Promise.resolve();
    });
    expect(
      (
        await createJsReconService(sdk, requestRepo).scan(
          "example.com",
          "scope-a",
          active,
        )
      ).kind,
    ).toBe("Error");
    expect(send).not.toHaveBeenCalled();
  });

  it("stops the run when a response audit write fails after sending", async () => {
    const { sdk, send } = fixture(2);
    const { repo, events } = memoryRepository();
    const append = repo.appendAudit;
    repo.appendAudit = vi.fn((projectId, event) =>
      event.type === "response"
        ? Promise.reject(new Error("audit unavailable"))
        : append(projectId, event),
    );
    const result = await createJsReconService(sdk, repo).scan(
      "example.com",
      "scope-a",
      active,
    );
    expect(result.kind).toBe("Error");
    expect(send).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "request",
      "finish",
    ]);
    expect(events.at(-1)?.outcome).toContain("audit unavailable");
  });

  it("records failed target sends without losing the run's audit trail", async () => {
    const { sdk, send } = fixture(1);
    const { repo, events } = memoryRepository();
    send.mockRejectedValueOnce(new Error("target refused"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const running = createJsReconService(sdk, repo).scan(
      "example.com",
      "scope-a",
      active,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await running;
    vi.useRealTimers();
    expect(result.kind).toBe("Ok");
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "request",
      "failure",
      "finish",
    ]);
    expect(events[2]?.outcome).toBe("target refused");
    if (result.kind === "Ok") {
      expect(result.value.activeRecon).toMatchObject({
        requestsSent: 1,
        failedRequests: 1,
      });
    }
  });

  it("records a valid live map as fetched without a failure", async () => {
    const { sdk, send } = fixture(1);
    const { repo, events } = memoryRepository();
    send.mockResolvedValueOnce({
      response: {
        getCode: () => 200,
        getBody: () => ({
          toText: () => '{"version":3,"sources":["app.ts"],"mappings":""}',
        }),
      },
    });
    const result = await createJsReconService(sdk, repo).scan(
      "example.com",
      "scope-a",
      { active: { delayMs: 1_000 } },
    );
    expect(result.kind).toBe("Ok");
    if (result.kind !== "Ok") return;
    expect(result.value.sourceMapsFetched).toEqual(["/bundle0.js.map"]);
    expect(result.value.sourceModules).toContain("app.ts");
    expect(result.value.activeRecon).toMatchObject({
      requestsSent: 1,
      failedRequests: 0,
      skippedOutOfScope: 0,
      requestBudget: "all",
    });
    expect(events[2]).toMatchObject({ type: "response", outcome: "received" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("treats omitted Caido RPC arguments as passive and scans every local page", async () => {
    const { sdk, send, requestedPages } = fixture(2_050);
    const { repo } = memoryRepository();
    const api = createJsReconApi(createJsReconService(sdk, repo));
    const result = await api.getJsRecon(
      sdk,
      "example.com",
      null as unknown as string,
      null as unknown as JsReconScanOptions,
    );
    expect(result.kind).toBe("Ok");
    if (result.kind !== "Ok") return;
    expect(result.value.bundlesScanned).toBe(2_050);
    expect(result.value.missingMapReferences).toBe(2_050);
    expect(result.value.truncated).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(
      requestedPages.filter((page) =>
        page.filter.includes('req.path.like:"%.js"'),
      ),
    ).toHaveLength(11);
  });

  it("uses earlier captured bodies when a newer JS or map response is 304", async () => {
    const { sdk, send } = fixture(2, {
      bundleLocation: () => ({ path: "/app.js" }),
      observedMaps: [{ path: "/app.js.map" }, { path: "/app.js.map" }],
      responseOverrides: {
        r0: { statusCode: 304, body: "" },
        r1: {
          statusCode: 200,
          body: 'fetch("/api/revalidated");\n//# sourceMappingURL=/app.js.map',
        },
        m0: { statusCode: 304, body: "" },
        m1: {
          statusCode: 200,
          body: JSON.stringify({
            version: 3,
            sources: ["module.ts"],
            sourcesContent: ['fetch("/api/from-map")'],
            mappings: "",
          }),
        },
      },
    });
    const { repo } = memoryRepository();
    const result = await createJsReconService(sdk, repo).scan(
      "example.com",
      "scope-a",
    );
    expect(result.kind).toBe("Ok");
    if (result.kind !== "Ok") return;
    expect(result.value.endpoints).toEqual([
      "/api/from-map",
      "/api/revalidated",
    ]);
    expect(result.value.sourceMaps).toEqual(["/app.js.map"]);
    expect(result.value.sourceModules).toEqual(["module.ts"]);
    expect(result.value.missingMapReferences).toBe(0);
    expect(result.value.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "/api/revalidated",
          requestId: "r1",
        }),
        expect.objectContaining({ value: "/api/from-map", requestId: "m1" }),
      ]),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("discovers header-only maps passively and fetches them only after consent", async () => {
    const { sdk, send } = fixture(1, {
      responseOverrides: {
        r0: {
          statusCode: 200,
          headers: ["sOuRcEmAp: /header.js.map"],
          body: 'fetch("/api/header-only");',
        },
      },
    });
    const { repo } = memoryRepository();
    const service = createJsReconService(sdk, repo);
    const passive = await service.scan("example.com", "scope-a");
    expect(passive.kind).toBe("Ok");
    if (passive.kind !== "Ok") return;
    expect(passive.value.missingMapReferences).toBe(1);
    expect(send).not.toHaveBeenCalled();

    const activeRun = await service.scan("example.com", "scope-a", {
      active: { delayMs: 1_000 },
    });
    expect(activeRun.kind).toBe("Ok");
    if (activeRun.kind !== "Ok") return;
    expect(send.mock.calls.map(([spec]) => spec.url)).toEqual([
      "https://example.com/header.js.map",
    ]);
  });

  it("uses SourceMap response headers instead of conflicting bundle footers", async () => {
    const { sdk, send } = fixture(1, {
      responseOverrides: {
        r0: {
          statusCode: 200,
          headers: ["SourceMap: /header.js.map"],
          body: 'fetch("/api/header");\n//# sourceMappingURL=/footer.js.map',
        },
      },
      observedMaps: [
        {
          path: "/header.js.map",
          body: JSON.stringify({
            version: 3,
            sources: ["original.ts"],
            sourcesContent: ['fetch("/api/from-header")'],
            mappings: "",
          }),
        },
      ],
    });
    const { repo } = memoryRepository();
    const result = await createJsReconService(sdk, repo).scan(
      "example.com",
      "scope-a",
    );
    expect(result.kind).toBe("Ok");
    if (result.kind !== "Ok") return;
    expect(result.value.sourceMaps).toEqual(["/header.js.map"]);
    expect(result.value.missingMapReferences).toBe(0);
    expect(result.value.endpoints).toEqual(["/api/from-header", "/api/header"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("discovers a new reference after the former 2,000-bundle ceiling", async () => {
    const { sdk, send } = fixture(2_001, {
      reference: (index) => (index === 2_000 ? "/late.map" : "/earlier.map"),
    });
    const { repo } = memoryRepository();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const running = createJsReconService(sdk, repo).scan(
        "example.com",
        "scope-a",
        {
          active: { delayMs: 1_000, maxRequests: 2 },
        },
      );
      await vi.runAllTimersAsync();
      const result = await running;
      expect(result.kind).toBe("Ok");
      if (result.kind !== "Ok") return;
      expect(result.value.bundlesScanned).toBe(2_001);
      expect(result.value.missingMapReferences).toBe(2);
      expect(result.value.activeRecon?.budgetExhausted).toBe(false);
      expect(send.mock.calls.map(([spec]) => spec.url)).toEqual([
        "https://example.com/earlier.map",
        "https://example.com/late.map",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("traverses all captured successful and blocked map pages beyond former limits", async () => {
    const { sdk, send, requestedPages } = fixture(1, {
      reference: () => "/observed0.map",
      observedMaps: Array.from({ length: 520 }, (_, index) => ({
        path: `/observed${index}.map`,
      })),
      blockedMaps: Array.from({ length: 520 }, (_, index) => ({
        path: `/blocked${index}.map`,
      })),
    });
    const { repo } = memoryRepository();
    const result = await createJsReconService(sdk, repo).scan(
      "example.com",
      "scope-a",
    );
    expect(result.kind).toBe("Ok");
    if (result.kind !== "Ok") return;
    expect(result.value.sourceMapsScanned).toBe(520);
    expect(result.value.sourceMapsBlocked).toHaveLength(520);
    expect(result.value.missingMapReferences).toBe(0);
    expect(result.value.truncated).toBe(false);
    expect(
      requestedPages.filter((page) =>
        page.filter.includes('req.path.like:"%.map"'),
      ),
    ).toHaveLength(6);
    expect(send).not.toHaveBeenCalled();
  });

  it("attempts more than 20 unique missing maps when opted in without a cap", async () => {
    const { sdk, send } = fixture(23);
    const { repo, events } = memoryRepository();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const running = createJsReconService(sdk, repo).scan(
        "example.com",
        "scope-a",
        {
          active: { delayMs: 1_000 },
        },
      );
      await vi.runAllTimersAsync();
      const result = await running;
      expect(result.kind).toBe("Ok");
      if (result.kind !== "Ok") return;
      expect(result.value.missingMapReferences).toBe(23);
      expect(result.value.activeRecon).toMatchObject({
        requestsSent: 23,
        requestBudget: "all",
        budgetExhausted: false,
        failedRequests: 23,
        skippedOutOfScope: 0,
      });
      expect(send).toHaveBeenCalledTimes(23);
      expect(events).toHaveLength(48);
      expect(
        events.every(
          (event) =>
            event.scopeId === "scope-a" &&
            event.host === "example.com" &&
            event.requestBudget === "all",
        ),
      ).toBe(true);
      expect(repo.appendAudit).toHaveBeenCalledWith(
        "project-a",
        expect.any(Object),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps query variants distinct even when one map variant was observed", async () => {
    const { sdk, send } = fixture(3, {
      reference: (index) => `/shared.js.map?v=${index + 1}`,
      observedMaps: [{ path: "/shared.js.map", query: "v=1" }],
    });
    const { repo } = memoryRepository();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const running = createJsReconService(sdk, repo).scan(
        "example.com",
        "scope-a",
        {
          active: { delayMs: 1_000 },
        },
      );
      await vi.runAllTimersAsync();
      const result = await running;
      expect(result.kind).toBe("Ok");
      if (result.kind !== "Ok") return;
      expect(result.value.sourceMaps).toEqual(["/shared.js.map?v=1"]);
      expect(result.value.missingMapReferences).toBe(2);
      expect(result.value.sourceMapsBlocked).toEqual([
        "/shared.js.map?v=2",
        "/shared.js.map?v=3",
      ]);
      expect(send.mock.calls.map(([spec]) => spec.url)).toEqual([
        "https://example.com/shared.js.map?v=2",
        "https://example.com/shared.js.map?v=3",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps each captured origin when exporting endpoints from shared paths", async () => {
    const { sdk, send } = fixture(3, {
      bundleLocation: (index) => ({
        path: "/app.js",
        isTls: index === 2,
        ...(index === 0 ? { port: 8080 } : {}),
      }),
      responseOverrides: {
        r0: {
          statusCode: 200,
          body: 'fetch("/api/origin"); fetch("https://other.example/v1");',
        },
        r1: { statusCode: 200, body: 'fetch("/api/origin");' },
        r2: {
          statusCode: 200,
          body: 'fetch("/api/origin"); fetch(`/api/items/${id}`);',
        },
      },
    });
    const { repo } = memoryRepository();
    const result = await createJsReconService(sdk, repo).scan(
      "example.com",
      "scope-a",
    );
    expect(result.kind).toBe("Ok");
    if (result.kind !== "Ok") return;
    expect(result.value.endpoints).toEqual([
      "/api/items/${id}",
      "/api/origin",
      "https://other.example/v1",
    ]);
    expect(result.value.endpointTargets).toEqual([
      "http://example.com/api/origin",
      "http://example.com:8080/api/origin",
      "https://example.com/api/items/${id}",
      "https://example.com/api/origin",
      "https://other.example/v1",
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("exports original-source leads using their captured map origin", async () => {
    const { sdk, send } = fixture(1, {
      bundleLocation: () => ({
        path: "/bundle0.js",
        isTls: false,
        port: 8080,
      }),
      observedMaps: [
        {
          path: "/bundle0.js.map",
          isTls: false,
          port: 8080,
          body: JSON.stringify({
            version: 3,
            sources: ["original.ts"],
            sourcesContent: ['fetch("/api/original")'],
            mappings: "",
          }),
        },
      ],
    });
    const { repo } = memoryRepository();
    const result = await createJsReconService(sdk, repo).scan(
      "example.com",
      "scope-a",
    );
    expect(result.kind).toBe("Ok");
    if (result.kind !== "Ok") return;
    expect(result.value.endpoints).toEqual(["/api/original"]);
    expect(result.value.endpointTargets).toEqual([
      "http://example.com:8080/api/original",
    ]);
    expect(result.value.missingMapReferences).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not collapse different schemes and ports onto one map request", async () => {
    const { sdk, send } = fixture(3, {
      reference: (index) =>
        [
          "https://example.com/shared.map",
          "http://example.com/shared.map",
          "https://example.com:8443/shared.map",
        ][index]!,
      bundleLocation: (index) => ({
        path: "/bundle.js",
        isTls: index !== 1,
        ...(index === 2 ? { port: 8443 } : {}),
      }),
      observedMaps: [{ path: "/shared.map" }],
    });
    const { repo } = memoryRepository();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const running = createJsReconService(sdk, repo).scan(
        "example.com",
        "scope-a",
        {
          active: { delayMs: 1_000 },
        },
      );
      await vi.runAllTimersAsync();
      const result = await running;
      expect(result.kind).toBe("Ok");
      if (result.kind !== "Ok") return;
      expect(result.value.bundlesScanned).toBe(3);
      expect(result.value.missingMapReferences).toBe(2);
      expect(send.mock.calls.map(([spec]) => spec.url)).toEqual([
        "http://example.com/shared.map",
        "https://example.com:8443/shared.map",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accounts for out-of-scope and failed target requests without pretending maps were fetched", async () => {
    const { sdk, send } = fixture(4);
    const { repo, events } = memoryRepository();
    vi.mocked(sdk.requests.inScope).mockImplementation(
      (spec) => !("url" in spec && String(spec.url).includes("bundle0")),
    );
    send
      .mockRejectedValueOnce(new Error("target refused"))
      .mockResolvedValueOnce({
        response: { getCode: () => 403, getBody: () => undefined },
      })
      .mockResolvedValueOnce({
        response: {
          getCode: () => 200,
          getBody: () => ({ toText: () => "not a source map" }),
        },
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const running = createJsReconService(sdk, repo).scan(
        "example.com",
        "scope-a",
        {
          active: { delayMs: 1_000 },
        },
      );
      await vi.runAllTimersAsync();
      const result = await running;
      expect(result.kind).toBe("Ok");
      if (result.kind !== "Ok") return;
      expect(result.value.activeRecon).toMatchObject({
        requestsSent: 3,
        requestBudget: "all",
        skippedOutOfScope: 1,
        failedRequests: 3,
        budgetExhausted: false,
      });
      expect(result.value.missingMapReferences).toBe(4);
      expect(result.value.sourceMapsFetched).toEqual([]);
      expect(result.value.sourceMapsBlocked).toEqual(["/bundle2.js.map"]);
      expect(
        events
          .filter((event) => event.type === "response")
          .map((event) => event.outcome),
      ).toEqual(["blocked", "invalid-map"]);
      expect(events.filter((event) => event.type === "request")).toHaveLength(
        3,
      );
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks scope after the pre-send audit and skips a newly excluded target", async () => {
    const { sdk, send } = fixture(1);
    const { repo, events } = memoryRepository();
    vi.mocked(sdk.requests.inScope)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const result = await createJsReconService(sdk, repo).scan(
      "example.com",
      "scope-a",
      { active: { delayMs: 1_000 } },
    );
    expect(result.kind).toBe("Ok");
    if (result.kind !== "Ok") return;
    expect(result.value.activeRecon).toMatchObject({
      requestsSent: 0,
      skippedOutOfScope: 1,
      failedRequests: 0,
    });
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "request",
      "failure",
      "finish",
    ]);
    expect(events[2]?.outcome).toBe("Scope changed before send.");
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["repeat", "empty", "missing"] as const)(
    "stops malformed %s pagination, but keeps scanning the other candidate lists",
    async (failure) => {
      const { sdk, send, requestedPages } = fixture(401, {
        pagination: (page) => (page === 1 ? failure : undefined),
        observedMaps: [{ path: "/bundle0.js.map" }],
      });
      const { repo } = memoryRepository();
      const result = await createJsReconService(sdk, repo).scan(
        "example.com",
        "scope-a",
      );
      expect(result.kind).toBe("Ok");
      if (result.kind !== "Ok") return;
      expect(result.value.truncated).toBe(true);
      expect(result.value.bundlesScanned).toBe(failure === "empty" ? 200 : 400);
      expect(result.value.sourceMapsScanned).toBe(1);
      expect(result.value.missingMapReferences).toBe(
        failure === "empty" ? 199 : 399,
      );
      expect(
        requestedPages.filter((entry) =>
          entry.filter.includes('req.path.like:"%.js"'),
        ),
      ).toHaveLength(2);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("stores audit events per project, scope and host in newest-first order", async () => {
    const { sdk, setProject, setScope } = fixture(0);
    const sqlite = new DatabaseSync(":memory:");
    Object.assign(sdk, {
      meta: {
        db: () =>
          Promise.resolve({
            exec: (sql: string) => {
              sqlite.exec(sql);
              return Promise.resolve();
            },
            prepare: (sql: string) => {
              const statement = sqlite.prepare(sql);
              return Promise.resolve({
                run: (...params: string[]) => {
                  statement.run(...params);
                  return Promise.resolve();
                },
                all: <T extends object>(...params: string[]) =>
                  Promise.resolve(statement.all(...params) as T[]),
              });
            },
          }),
      },
    });
    try {
      const repo = createJsReconRepository(sdk);
      const event: JsReconAuditEvent = {
        type: "start",
        runId: "run",
        time: new Date().toISOString(),
        scopeId: "scope-a",
        host: "example.com",
        requestBudget: "all",
        delayMs: 1_000,
      };
      for (let index = 0; index < 101; index += 1) {
        await repo.appendAudit("project-a", {
          ...event,
          runId: `run-${index}`,
        });
      }
      await repo.appendAudit("project-b", event);
      await repo.appendAudit("project-a", { ...event, scopeId: "scope-b" });
      await repo.appendAudit("project-a", { ...event, host: "other.com" });
      const service = createJsReconService(sdk, repo);
      const route = createAgentRoutes(
        sdk,
        {} as Parameters<typeof createAgentRoutes>[1],
        service,
      ).find((entry) => entry.path === "/js-recon/audit");
      expect(route).toBeDefined();
      const response = await route!.handle(
        new URLSearchParams("host=EXAMPLE.COM&scope=scope-a"),
      );
      expect(response.status).toBe(200);
      const events = auditEventsFrom(response.body);
      expect(events).toHaveLength(100);
      expect(events[0]).toMatchObject({
        runId: "run-100",
        requestBudget: "all",
      });
      expect(events.at(-1)).toMatchObject({ runId: "run-1" });

      setProject("project-b");
      const otherProject = await route!.handle(
        new URLSearchParams("host=example.com&scope=scope-a"),
      );
      expect(auditEventsFrom(otherProject.body)).toHaveLength(1);
      setScope("scope-b");
      const otherScope = await route!.handle(
        new URLSearchParams("host=example.com&scope=scope-b"),
      );
      expect(auditEventsFrom(otherScope.body)).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
});
