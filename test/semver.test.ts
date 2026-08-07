import { describe, expect, test } from "bun:test";

import { compareSemver, parseSemver } from "../src/semver";

describe("compatibilidade SemVer", () => {
  test("compara versões completas sem coerção", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.1.0", "1.0.9")).toBe(1);
    expect(compareSemver("1.0.9", "1.1.0")).toBe(-1);
  });

  test("rejeita versão parcial ou prefixada", () => {
    expect(() => parseSemver("1.0")).toThrow();
    expect(() => parseSemver("v1.0.0")).toThrow();
  });
});
