import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BrandResolver, CacheStore } from "../src/cache";
import { EXIT_CODES } from "../src/constants";
import { GitHubClient } from "../src/github";
import { sha256 } from "../src/security";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryCache() {
  const root = await mkdtemp(path.join(tmpdir(), "jerasoft-cli-cache-test-"));
  temporaryRoots.push(root);
  return new CacheStore(path.join(root, "cache"));
}

function fixture() {
  const payloadContents = new TextEncoder().encode("conteúdo aprovado");
  const manifest = {
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
        id: "contract.jerasoft-ui",
        kind: "contract",
        releaseAssetName: "contract--jerasoft-ui--1.0.0.md",
        mediaType: "text/markdown",
        bytes: payloadContents.byteLength,
        sha256: sha256(payloadContents),
        version: "1.0.0",
        status: "approved",
      },
    ],
  };
  const manifestContents = new TextEncoder().encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const manifestDigest = sha256(manifestContents);
  const release = {
    id: 10,
    tag_name: "brand-kit-v1.0.0",
    target_commitish: "b".repeat(40),
    draft: false,
    prerelease: false,
    immutable: true,
    assets: [
      {
        id: 11,
        name: "manifest.json",
        size: manifestContents.byteLength,
        digest: `sha256:${manifestDigest}`,
        state: "uploaded",
      },
      {
        id: 12,
        name: "contract--jerasoft-ui--1.0.0.md",
        size: payloadContents.byteLength,
        digest: `sha256:${sha256(payloadContents)}`,
        state: "uploaded",
      },
    ],
  };
  return {
    manifest,
    manifestContents,
    manifestDigest,
    payloadContents,
    release,
  };
}

function nextResponse(responses: Response[]) {
  const response = responses.shift();
  if (!response) throw new Error("Resposta de teste ausente.");
  return Promise.resolve(response);
}

describe("resolução e cache", () => {
  test("baixa, valida e reaproveita manifesto com ETag", async () => {
    const cache = await temporaryCache();
    const data = fixture();
    let request = 0;
    const fetcher = () => {
      request += 1;
      if (request === 1) {
        return Promise.resolve(
          new Response(JSON.stringify(data.release), {
            status: 200,
            headers: { ETag: '"release-1"' },
          }),
        );
      }
      if (request === 2)
        return Promise.resolve(new Response(data.manifestContents));
      return Promise.resolve(new Response(null, { status: 304 }));
    };
    const resolver = new BrandResolver(
      cache,
      new GitHubClient(fetcher),
      () => new Date("2026-08-07T12:00:00.000Z"),
    );

    const first = await resolver.resolveManifest({ token: "ghu_teste" });
    expect(first.cacheState).toBe("fresh");
    expect(first.manifestSha256).toBe(data.manifestDigest);
    const second = await resolver.resolveManifest({ token: "ghu_teste" });
    expect(second.cacheState).toBe("cached");
    expect(request).toBe(3);
  });

  test("usa cache recente em erro de rede, mas nunca em 401", async () => {
    const cache = await temporaryCache();
    const data = fixture();
    const bootstrapResponses = [
      new Response(JSON.stringify(data.release), {
        status: 200,
        headers: { ETag: '"release-1"' },
      }),
      new Response(data.manifestContents),
    ];
    const bootstrap = new BrandResolver(
      cache,
      new GitHubClient(() => nextResponse(bootstrapResponses)),
      () => new Date("2026-08-07T12:00:00.000Z"),
    );
    await bootstrap.resolveManifest({ token: "ghu_teste" });

    const offlineNetwork = new BrandResolver(
      cache,
      new GitHubClient(() => Promise.reject(new Error("offline"))),
      () => new Date("2026-08-08T12:00:00.000Z"),
    );
    expect(
      (await offlineNetwork.resolveManifest({ token: "ghu_teste" })).cacheState,
    ).toBe("stale");

    const unauthorized = new BrandResolver(
      cache,
      new GitHubClient(() =>
        Promise.resolve(new Response(null, { status: 401 })),
      ),
      () => new Date("2026-08-08T12:00:00.000Z"),
    );
    expect(
      unauthorized.resolveManifest({ token: "ghu_revogado" }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.authentication });
  });

  test("não usa cache vencido nem ignora --fresh", async () => {
    const cache = await temporaryCache();
    const data = fixture();
    const bootstrapResponses = [
      new Response(JSON.stringify(data.release), { status: 200 }),
      new Response(data.manifestContents),
    ];
    const bootstrap = new BrandResolver(
      cache,
      new GitHubClient(() => nextResponse(bootstrapResponses)),
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    await bootstrap.resolveManifest({ token: "ghu_teste" });

    const failing = new BrandResolver(
      cache,
      new GitHubClient(() => Promise.reject(new Error("offline"))),
      () => new Date("2026-03-01T00:00:00.000Z"),
    );
    expect(
      failing.resolveManifest({ token: "ghu_teste" }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.networkWithoutCache });
    expect(
      failing.resolveManifest({ token: "ghu_teste", fresh: true }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.networkWithoutCache });
  });
});
