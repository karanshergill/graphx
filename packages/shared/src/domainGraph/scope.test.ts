import { describe, expect, it } from "vitest";

import { createScopeMatcher } from "./scope";
import type { ScopeDefinition } from "./types";

const scope: ScopeDefinition = {
  id: "1",
  name: "Example",
  allowlist: ["example.com", "*.example.com", "api?.other.test"],
  denylist: ["private.example.com", "*.blocked.example.com"],
};

describe("createScopeMatcher", () => {
  const matches = createScopeMatcher(scope);

  it("matches exact domains and subdomain wildcards case-insensitively", () => {
    expect(matches("EXAMPLE.COM.")).toBe(true);
    expect(matches("api.stage.example.com")).toBe(true);
  });

  it("applies single-character wildcards", () => {
    expect(matches("api1.other.test")).toBe(true);
    expect(matches("api12.other.test")).toBe(false);
  });

  it("gives denylist patterns precedence", () => {
    expect(matches("private.example.com")).toBe(false);
    expect(matches("deep.blocked.example.com")).toBe(false);
  });

  it("rejects invalid hosts and IP addresses", () => {
    expect(matches("not example.com")).toBe(false);
    expect(matches("127.0.0.1")).toBe(false);
  });
});
