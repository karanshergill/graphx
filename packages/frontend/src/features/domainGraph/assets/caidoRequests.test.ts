import { describe, expect, it } from "vitest";

import type { FrontendSDK } from "../../../types";

import { readJsAssetRequests } from "./caidoRequests";

describe("captured JS asset sweep", () => {
  it("accepts decoded MIME-confirmed responses, not MIME text in bodies", async () => {
    const edges = [
      {
        node: {
          host: "example.com",
          path: "/assets/entry",
          createdAt: "2026-11-07T00:00:00Z",
          response: { id: "js", statusCode: 200 },
        },
      },
      {
        node: {
          host: "example.com",
          path: "/assets/decoy",
          createdAt: "2026-11-07T00:00:00Z",
          response: { id: "decoy", statusCode: 200 },
        },
      },
      {
        node: {
          host: "example.com",
          path: "/assets/legacy.js",
          createdAt: "2026-11-07T00:00:00Z",
          response: { id: "legacy", statusCode: 200 },
        },
      },
    ];
    const page = { requests: { edges, pageInfo: { hasNextPage: false } } };
    const sdk = {
      graphql: {
        requests: () => Promise.resolve(page),
        response: ({ id }: { id: string }) =>
          Promise.resolve({
            response: {
              // Caido's frontend SDK returns decoded HTTP text, not base64.
              raw:
                id === "js"
                  ? 'HTTP/1.1 200 OK\r\nContent-Type: text/javascript; charset=utf-8\r\n\r\nfetch("/api/entry")'
                  : "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n// Content-Type: text/javascript",
            },
          }),
      },
    } as unknown as FrontendSDK;

    const result = await readJsAssetRequests(sdk, "scope-a");
    expect(result.requests.map((request) => request.path)).toEqual([
      "/assets/entry",
      "/assets/legacy.js",
    ]);
    expect(result.requests[0]?.isJavaScript).toBe(true);
  });
});
