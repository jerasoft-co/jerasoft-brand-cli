import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertSafeParentChain,
  atomicWriteFile,
  readRegularFile,
  resolveInside,
  sha256,
} from "../src/security";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "jerasoft-security-test-"));
  temporaryRoots.push(root);
  return root;
}

describe("escrita segura", () => {
  test("escreve atomicamente e calcula SHA-256", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "nested", "arquivo.txt");
    await atomicWriteFile(target, "conteúdo", 0o600);
    expect(await readFile(target, "utf8")).toBe("conteúdo");
    expect(sha256("conteúdo")).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejeita traversal e links simbólicos", async () => {
    const root = await temporaryRoot();
    expect(() => resolveInside(root, "../fora.txt")).toThrow(
      "dentro do projeto",
    );
    await symlink(tmpdir(), path.join(root, "atalho"));
    expect(readRegularFile(path.join(root, "atalho"))).rejects.toThrow(
      "arquivo regular",
    );
    expect(
      assertSafeParentChain(root, path.join(root, "atalho", "arquivo.txt")),
    ).rejects.toThrow("segmento inseguro");
  });
});
