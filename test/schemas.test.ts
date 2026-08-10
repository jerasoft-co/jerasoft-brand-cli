import { describe, expect, test } from "bun:test";

import {
  distributionManifestSchema,
  cachedReleaseSchema,
  projectConfigSchema,
  projectLockSchema,
  type Receipt,
  receiptSchema,
} from "../src/schemas";

const digest = "a".repeat(64);

describe("schemas públicos do protocolo", () => {
  test("aceita um manifesto v1 mínimo e estrito", () => {
    expect(
      distributionManifestSchema.parse({
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
            id: "contract.interface",
            kind: "contract",
            releaseAssetName: "contract--interface--1.0.0.md",
            mediaType: "text/markdown",
            bytes: 10,
            sha256: digest,
            version: "1.0.0",
            status: "approved",
          },
        ],
      }).releaseTag,
    ).toBe("brand-kit-v1.0.0");
  });

  test("rejeita schema futuro, campos extras e traversal", () => {
    expect(() =>
      distributionManifestSchema.parse({ schemaVersion: 2 }),
    ).toThrow();
    expect(() =>
      projectConfigSchema.parse({
        schemaVersion: 2,
        protocol: 1,
        channel: "stable",
        cliRange: "^1.0.0",
        contractRange: "^1.0.0",
        updatePolicy: "compatible",
        agentArtifacts: ["instructions", "skills"],
        assetDirectory: "../private",
        token: "proibido",
      }),
    ).toThrow();
  });

  test("receipt não aceita token nem conteúdo privado", () => {
    const receipt: Receipt = {
      schemaVersion: 1,
      releaseTag: "brand-kit-v1.0.0",
      resolvedAt: "2026-08-07T12:00:00.000Z",
      cacheState: "fresh",
      versions: {
        contract: "1.0.0",
        skills: "1.0.0",
        assets: "1.0.0",
      },
      manifestSha256: digest,
    };
    expect(receiptSchema.parse(receipt)).toEqual(receipt);
    expect(() =>
      receiptSchema.parse({ ...receipt, token: "proibido" }),
    ).toThrow();
  });

  test("lock e cache aceitam somente proveniência pública", () => {
    const payload = {
      id: "asset.logo",
      kind: "asset" as const,
      releaseAssetName: "asset--logo--1.0.0.svg",
      mediaType: "image/svg+xml",
      bytes: 10,
      sha256: digest,
      version: "1.0.0",
      status: "approved" as const,
      recommendedFilename: "logo.svg",
    };
    expect(
      projectLockSchema.parse({
        schemaVersion: 1,
        protocol: 1,
        channel: "stable",
        releaseTag: "brand-kit-v1.0.0",
        sourceCommit: "b".repeat(40),
        resolvedAt: "2026-08-07T12:00:00.000Z",
        versions: {
          bundle: "1.0.0",
          contract: "1.0.0",
          skills: "1.0.0",
          assets: "1.0.0",
        },
        manifestSha256: digest,
        payloads: [payload],
      }).payloads,
    ).toEqual([payload]);
    expect(() =>
      cachedReleaseSchema.parse({
        schemaVersion: 1,
        etag: '"abc"',
        checkedAt: "2026-08-07T12:00:00.000Z",
        manifestSha256: digest,
        release: {
          id: 1,
          tagName: "brand-kit-v1.0.0",
          targetCommitish: "b".repeat(40),
          assets: [
            {
              id: 2,
              name: "manifest.json",
              size: 10,
              digest: `sha256:${digest}`,
              browserDownloadUrl: "https://example.com?token=proibido",
            },
          ],
        },
      }),
    ).toThrow();
  });
});
