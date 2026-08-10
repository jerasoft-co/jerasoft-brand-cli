import { describe, expect, test } from "bun:test";

import { resolveReleaseIdentity, selectWorkflowRun } from "../tooling/release";

describe("automação de release", () => {
  test("deriva pacote e tag da versão exata do package.json", () => {
    expect(
      resolveReleaseIdentity({ name: "@jerasoft/brand", version: "1.1.0" }),
    ).toEqual({
      packageName: "@jerasoft/brand",
      version: "1.1.0",
      tag: "v1.1.0",
    });
  });

  test("rejeita metadados ausentes e versões que não sejam SemVer completas", () => {
    expect(() => resolveReleaseIdentity({ version: "1.1.0" })).toThrow();
    expect(() =>
      resolveReleaseIdentity({ name: "@jerasoft/brand", version: "v1.1.0" }),
    ).toThrow();
  });

  test("seleciona somente o workflow do commit publicado", () => {
    const runs = [
      { databaseId: 10, headSha: "anterior" },
      { databaseId: 11, headSha: "release" },
    ];
    expect(selectWorkflowRun(runs, "release")).toEqual(runs[1]);
    expect(selectWorkflowRun(runs, "inexistente")).toBeUndefined();
  });
});
