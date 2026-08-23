import { describe, expect, it } from "vitest";

import { syncCaidoThemeMode } from "./caidoTheme";

class AttributeHost {
  readonly values = new Map<string, string>();

  getAttribute(name: string) {
    return this.values.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.values.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.values.set(name, value);
  }
}

describe("syncCaidoThemeMode", () => {
  it("copies dark and light modes onto the scoped plugin root", () => {
    const source = new AttributeHost();
    const target = new AttributeHost();

    source.setAttribute("data-mode", "dark");
    syncCaidoThemeMode(source, target);
    expect(target.getAttribute("data-mode")).toBe("dark");

    source.setAttribute("data-mode", "light");
    syncCaidoThemeMode(source, target);
    expect(target.getAttribute("data-mode")).toBe("light");
  });

  it("removes a stale plugin mode when Caido has no explicit mode", () => {
    const source = new AttributeHost();
    const target = new AttributeHost();
    target.setAttribute("data-mode", "dark");

    syncCaidoThemeMode(source, target);

    expect(target.getAttribute("data-mode")).toBeNull();
  });
});
