import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GitHubAuthenticator } from "../src/auth";
import { BrandResolver, CacheStore } from "../src/cache";
import { executeCommand, type CommandRuntime } from "../src/commands";
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

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}

function protocolFixture() {
  const payloadSources = [
    {
      id: "contract.jerasoft-ui",
      kind: "contract",
      name: "contract--jerasoft-ui--1.0.0.md",
      mediaType: "text/markdown",
      contents: "# Contrato aprovado\n",
    },
    {
      id: "skill.jerasoft-apply-brand",
      kind: "skill",
      name: "skill--jerasoft-apply-brand--1.0.0.md",
      mediaType: "text/markdown",
      contents: "# Aplicar marca\n",
    },
    {
      id: "skill.jerasoft-audit-interface",
      kind: "skill",
      name: "skill--jerasoft-audit-interface--1.0.0.md",
      mediaType: "text/markdown",
      contents: "# Auditar interface\n",
    },
    {
      id: "skill.jerasoft-resolve-assets",
      kind: "skill",
      name: "skill--jerasoft-resolve-assets--1.0.0.md",
      mediaType: "text/markdown",
      contents: "# Resolver ativos\n",
    },
    {
      id: "logo.jerasoft.symbol.default",
      kind: "asset",
      name: "asset--logo.jerasoft.symbol.default--1.0.0.svg",
      mediaType: "image/svg+xml",
      contents: "<svg>oficial</svg>",
      recommendedFilename: "jerasoft-symbol.svg",
    },
  ] as const;
  const payloads = payloadSources.map((source) => {
    const bytes = new TextEncoder().encode(source.contents);
    return {
      id: source.id,
      kind: source.kind,
      releaseAssetName: source.name,
      mediaType: source.mediaType,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      version: "1.0.0",
      status: "approved",
      ...("recommendedFilename" in source
        ? { recommendedFilename: source.recommendedFilename }
        : {}),
    };
  });
  const manifest = {
    schemaVersion: 1,
    protocolVersion: 1,
    releaseTag: "brand-kit-v1.0.0",
    sourceRepository: "jerasoft-co/portfolio-jerasoft",
    sourceCommit: "c".repeat(40),
    generatedAt: "2026-08-07T12:00:00.000Z",
    channel: "stable",
    minimumCliVersion: "1.0.0",
    versions: {
      bundle: "1.0.0",
      contract: "1.0.0",
      skills: "1.0.0",
      assets: "1.0.0",
    },
    payloads,
  };
  const manifestBytes = new TextEncoder().encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const assets = [
    {
      id: 100,
      name: "manifest.json",
      size: manifestBytes.byteLength,
      digest: `sha256:${sha256(manifestBytes)}`,
      state: "uploaded",
    },
    ...payloadSources.map((source, index) => {
      const bytes = new TextEncoder().encode(source.contents);
      return {
        id: 101 + index,
        name: source.name,
        size: bytes.byteLength,
        digest: `sha256:${sha256(bytes)}`,
        state: "uploaded",
      };
    }),
  ];
  const downloads = new Map<number, Uint8Array>([[100, manifestBytes]]);
  payloadSources.forEach((source, index) => {
    downloads.set(101 + index, new TextEncoder().encode(source.contents));
  });
  return {
    release: {
      id: 10,
      tag_name: "brand-kit-v1.0.0",
      target_commitish: "c".repeat(40),
      draft: false,
      prerelease: false,
      immutable: true,
      assets,
    },
    downloads,
  };
}

describe("fluxo público do CLI", () => {
  test("inicializa, resolve contexto e ativo, e audita offline", async () => {
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), "jerasoft-commands-project-"),
    );
    const cacheRoot = await mkdtemp(
      path.join(tmpdir(), "jerasoft-commands-cache-"),
    );
    temporaryRoots.push(projectRoot, cacheRoot);
    const fixture = protocolFixture();
    let latestRequests = 0;
    const fetcher = (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/releases/latest")) {
        latestRequests += 1;
        if (latestRequests > 1)
          return Promise.resolve(new Response(null, { status: 304 }));
        return Promise.resolve(
          new Response(JSON.stringify(fixture.release), {
            status: 200,
            headers: { ETag: '"release-1"' },
          }),
        );
      }
      const match = /\/releases\/assets\/(\d+)$/.exec(url);
      const assetId = Number(match?.[1]);
      const contents = fixture.downloads.get(assetId);
      if (!contents)
        return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(new Response(contents));
    };
    const capture = captureIo();
    const cache = new CacheStore(path.join(cacheRoot, "cache"));
    const runtime: CommandRuntime = {
      projectRoot,
      cache,
      authenticator: new GitHubAuthenticator(capture.io, {
        environment: { GH_TOKEN: "ghu_teste" },
      }),
      resolver: new BrandResolver(
        cache,
        new GitHubClient(fetcher),
        () => new Date("2026-08-07T12:00:00.000Z"),
      ),
      now: () => new Date("2026-08-07T12:00:00.000Z"),
    };

    expect(
      await executeCommand(
        { kind: "init", dryRun: false, adapter: "generic" },
        capture.io,
        runtime,
      ),
    ).toBe(EXIT_CODES.success);
    expect(
      await executeCommand(
        {
          kind: "context",
          profile: "apply",
          format: "json",
          fresh: false,
        },
        capture.io,
        runtime,
      ),
    ).toBe(EXIT_CODES.success);
    expect(capture.stdout.at(-1)).toContain("Contrato aprovado");

    expect(
      await executeCommand(
        {
          kind: "asset",
          id: "logo.jerasoft.symbol.default",
          copyTo: "assets/brand/symbol.svg",
          fresh: false,
        },
        capture.io,
        runtime,
      ),
    ).toBe(EXIT_CODES.success);
    expect(
      await readFile(path.join(projectRoot, "assets/brand/symbol.svg"), "utf8"),
    ).toBe("<svg>oficial</svg>");

    expect(
      await executeCommand(
        { kind: "audit", frozen: true, offline: true },
        capture.io,
        runtime,
      ),
    ).toBe(EXIT_CODES.success);
    expect(capture.stdout.at(-1)).toContain("lock íntegro");
    expect(capture.stderr).toEqual([]);
  });
});
