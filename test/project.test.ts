import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ResolvedManifest } from "../src/cache";
import {
  createDefaultConfig,
  initializeProject,
  loadProjectConfig,
  loadProjectLock,
  lockFromResolved,
  materializeAsset,
} from "../src/project";
import { distributionManifestSchema } from "../src/schemas";
import { sha256 } from "../src/security";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "jerasoft-project-test-"));
  temporaryRoots.push(root);
  return root;
}

function resolvedFixture(): ResolvedManifest {
  const asset = new TextEncoder().encode("<svg></svg>");
  const manifest = distributionManifestSchema.parse({
    schemaVersion: 1,
    protocolVersion: 1,
    releaseTag: "brand-kit-v1.0.0",
    sourceRepository: "jerasoft-co/portfolio-jerasoft",
    sourceCommit: "b".repeat(40),
    generatedAt: "2026-08-07T12:00:00.000Z",
    channel: "stable",
    minimumCliVersion: "1.0.0",
    versions: {
      bundle: "1.0.0",
      contract: "1.0.0",
      skills: "1.0.0",
      assets: "1.0.0",
    },
    payloads: [
      {
        id: "logo.jerasoft.symbol.default",
        kind: "asset",
        releaseAssetName: "asset--logo.jerasoft.symbol.default--1.0.0.svg",
        mediaType: "image/svg+xml",
        bytes: asset.byteLength,
        sha256: sha256(asset),
        version: "1.0.0",
        status: "approved",
        recommendedFilename: "jerasoft-symbol.svg",
      },
    ],
  });
  const firstPayload = manifest.payloads[0];
  if (!firstPayload) throw new Error("Fixture sem payload.");
  return {
    manifest,
    manifestSha256: "a".repeat(64),
    release: {
      id: 1,
      tagName: manifest.releaseTag,
      targetCommitish: manifest.sourceCommit,
      assets: [
        {
          id: 2,
          name: "manifest.json",
          size: 1,
          digest: `sha256:${"a".repeat(64)}`,
        },
        {
          id: 3,
          name: firstPayload.releaseAssetName,
          size: asset.byteLength,
          digest: `sha256:${sha256(asset)}`,
        },
      ],
    },
    cacheState: "fresh",
  };
}

describe("bootstrap de projeto", () => {
  test("gera configuração, lock, bloco gerenciado e skills finas", async () => {
    const root = await temporaryRoot();
    const config = createDefaultConfig(["generic", "codex"]);
    const lock = lockFromResolved(
      resolvedFixture(),
      new Date("2026-08-07T12:00:00.000Z"),
    );
    await initializeProject(root, config, lock);
    await initializeProject(root, config, lock);

    expect(await loadProjectConfig(root)).toEqual(config);
    expect((await loadProjectLock(root)).releaseTag).toBe("brand-kit-v1.0.0");
    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agents.match(/jerasoft-brand:start/g)).toHaveLength(1);
    expect(
      await readFile(
        path.join(root, ".agents/skills/jerasoft-apply-brand/SKILL.md"),
        "utf8",
      ),
    ).toContain("context --profile=apply");
  });

  test("materializa somente dentro do diretório configurado e não sobrescreve drift", async () => {
    const root = await temporaryRoot();
    const config = createDefaultConfig(["generic"]);
    const resolved = resolvedFixture();
    const payload = resolved.manifest.payloads[0];
    if (!payload) throw new Error("Fixture sem payload.");
    const contents = new TextEncoder().encode("<svg></svg>");

    const first = await materializeAsset(
      root,
      config,
      "assets/brand/symbol.svg",
      payload,
      contents,
    );
    expect(first.changed).toBe(true);
    expect(
      (
        await materializeAsset(
          root,
          config,
          "assets/brand/symbol.svg",
          payload,
          contents,
        )
      ).changed,
    ).toBe(false);
    expect(
      materializeAsset(root, config, "public/symbol.svg", payload, contents),
    ).rejects.toThrow("dentro de assets/brand");
  });
});
