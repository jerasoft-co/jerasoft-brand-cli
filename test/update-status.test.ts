import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ResolvedManifest } from "../src/cache";
import { EXIT_CODES } from "../src/constants";
import { CliError } from "../src/errors";
import { createDefaultConfig, lockFromResolved } from "../src/project";
import {
  distributionManifestSchema,
  projectConfigSchema,
  type ProjectLock,
} from "../src/schemas";
import { sha256 } from "../src/security";
import {
  createBrandUpdateChecker,
  type BrandUpdateDependencies,
} from "../src/update-status";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryProject() {
  const root = await mkdtemp(path.join(tmpdir(), "brand-update-test-"));
  temporaryRoots.push(root);
  return root;
}

function resolvedFixture(
  versions: Partial<ResolvedManifest["manifest"]["versions"]> = {},
  cacheState: ResolvedManifest["cacheState"] = "fresh",
): ResolvedManifest {
  const completeVersions = {
    bundle: "1.1.0",
    contract: "1.1.0",
    skills: "1.1.0",
    assets: "1.1.0",
    ...versions,
  };
  const payload = {
    id: "contract.public-fixture",
    kind: "contract" as const,
    releaseAssetName: "contract--public-fixture.md",
    mediaType: "text/markdown",
    bytes: 16,
    sha256: "b".repeat(64),
    version: completeVersions.contract,
    status: "approved" as const,
  };
  const manifest = distributionManifestSchema.parse({
    schemaVersion: 1,
    protocolVersion: 1,
    releaseTag: `brand-kit-v${completeVersions.bundle}`,
    sourceRepository: "jerasoft-co/portfolio-jerasoft",
    sourceCommit: "a".repeat(40),
    generatedAt: "2026-08-11T12:00:00.000Z",
    channel: "stable",
    minimumCliVersion: "1.0.0",
    versions: completeVersions,
    payloads: [payload],
  });
  const manifestSha256 = sha256(JSON.stringify(manifest));
  return {
    manifest,
    manifestSha256,
    release: {
      id: 100,
      tagName: manifest.releaseTag,
      targetCommitish: manifest.sourceCommit,
      assets: [
        {
          id: 101,
          name: "manifest.json",
          size: 1,
          digest: `sha256:${manifestSha256}`,
        },
      ],
    },
    cacheState,
  };
}

async function writeState(
  projectRoot: string,
  resolved: ResolvedManifest,
  options: { contractRange?: string; lock?: ProjectLock | null } = {},
) {
  const brandRoot = path.join(projectRoot, ".jerasoft");
  await mkdir(brandRoot, { recursive: true });
  const config = projectConfigSchema.parse({
    ...createDefaultConfig(),
    contractRange: options.contractRange ?? "^1.1.0",
  });
  await writeFile(
    path.join(brandRoot, "brand.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  if (options.lock !== null) {
    const lock = options.lock ?? lockFromResolved(resolved);
    await writeFile(
      path.join(brandRoot, "brand.lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`,
    );
  }
}

function dependencies(
  resolved: ResolvedManifest,
  overrides: Partial<BrandUpdateDependencies> = {},
) {
  return {
    authenticator: {
      resolveTokenSilently: () =>
        Promise.resolve({
          token: "ghu_fixture",
          source: "environment" as const,
        }),
    },
    resolver: {
      resolveManifest: () => Promise.resolve(resolved),
    },
    ...overrides,
  } satisfies BrandUpdateDependencies;
}

describe("estado de atualização da marca", () => {
  test("projeto não inicializado não consulta autenticação nem manifesto", async () => {
    const projectRoot = await temporaryProject();
    let authenticationCalls = 0;
    let resolverCalls = 0;
    const checker = createBrandUpdateChecker({
      authenticator: {
        resolveTokenSilently: () => {
          authenticationCalls += 1;
          return Promise.resolve(null);
        },
      },
      resolver: {
        resolveManifest: () => {
          resolverCalls += 1;
          return Promise.resolve(resolvedFixture());
        },
      },
    });

    expect(await checker(projectRoot)).toEqual({ kind: "not-initialized" });
    expect(authenticationCalls).toBe(0);
    expect(resolverCalls).toBe(0);
  });

  test("configuração sem lock não consulta autenticação nem manifesto", async () => {
    const projectRoot = await temporaryProject();
    const resolved = resolvedFixture();
    await writeState(projectRoot, resolved, { lock: null });
    let externalCalls = 0;
    const checker = createBrandUpdateChecker({
      authenticator: {
        resolveTokenSilently: () => {
          externalCalls += 1;
          return Promise.resolve(null);
        },
      },
      resolver: {
        resolveManifest: () => {
          externalCalls += 1;
          return Promise.resolve(resolved);
        },
      },
    });

    expect(await checker(projectRoot)).toEqual({ kind: "lock-missing" });
    expect(externalCalls).toBe(0);
  });

  test("lock idêntico ao manifesto está vigente", async () => {
    const projectRoot = await temporaryProject();
    const resolved = resolvedFixture();
    await writeState(projectRoot, resolved);

    expect(
      await createBrandUpdateChecker(dependencies(resolved))(projectRoot),
    ).toMatchObject({ kind: "current", cacheState: "fresh" });
  });

  test("contrato compatível mais novo está disponível", async () => {
    const projectRoot = await temporaryProject();
    const installed = resolvedFixture();
    const available = resolvedFixture({
      bundle: "1.2.0",
      contract: "1.2.0",
      skills: "1.2.0",
      assets: "1.2.0",
    });
    await writeState(projectRoot, installed);

    expect(
      await createBrandUpdateChecker(dependencies(available))(projectRoot),
    ).toMatchObject({
      kind: "update-available",
      installed: { contract: "1.1.0" },
      available: { contract: "1.2.0" },
    });
  });

  test("bundle, skills e assets novos contam com contrato igual", async () => {
    const projectRoot = await temporaryProject();
    const installed = resolvedFixture();
    const available = resolvedFixture({
      bundle: "1.2.0",
      skills: "1.2.0",
      assets: "1.2.0",
    });
    await writeState(projectRoot, installed);

    expect(
      await createBrandUpdateChecker(dependencies(available))(projectRoot),
    ).toMatchObject({ kind: "update-available" });
  });

  test("major fora do range exige migração", async () => {
    const projectRoot = await temporaryProject();
    const installed = resolvedFixture();
    const available = resolvedFixture({
      bundle: "2.0.0",
      contract: "2.0.0",
      skills: "2.0.0",
      assets: "2.0.0",
    });
    await writeState(projectRoot, installed, { contractRange: "^1.1.0" });

    expect(
      await createBrandUpdateChecker(dependencies(available))(projectRoot),
    ).toMatchObject({ kind: "major-update" });
  });

  test("manifesto mais antigo não recomenda downgrade", async () => {
    const projectRoot = await temporaryProject();
    const installed = resolvedFixture({
      bundle: "1.2.0",
      contract: "1.2.0",
      skills: "1.2.0",
      assets: "1.2.0",
    });
    const available = resolvedFixture();
    await writeState(projectRoot, installed);

    expect(
      await createBrandUpdateChecker(dependencies(available))(projectRoot),
    ).toMatchObject({ kind: "local-ahead" });
  });

  test("sem token usa cache íntegro sem Device Flow", async () => {
    const projectRoot = await temporaryProject();
    const resolved = resolvedFixture({}, "stale");
    await writeState(projectRoot, resolved);
    let options: unknown;
    const checker = createBrandUpdateChecker({
      authenticator: {
        resolveTokenSilently: () => Promise.resolve(null),
      },
      resolver: {
        resolveManifest: (received) => {
          options = received;
          return Promise.resolve(resolved);
        },
      },
    });

    expect(await checker(projectRoot)).toMatchObject({
      kind: "current",
      cacheState: "stale",
    });
    expect(options).toMatchObject({ offline: true });
    expect(options).not.toHaveProperty("token");
  });

  test("sem token e sem cache fica indisponível por autenticação", async () => {
    const projectRoot = await temporaryProject();
    const resolved = resolvedFixture();
    await writeState(projectRoot, resolved);
    const checker = createBrandUpdateChecker({
      authenticator: {
        resolveTokenSilently: () => Promise.resolve(null),
      },
      resolver: {
        resolveManifest: () =>
          Promise.reject(
            new CliError("cache ausente", EXIT_CODES.networkWithoutCache),
          ),
      },
    });

    expect(await checker(projectRoot)).toMatchObject({
      kind: "unavailable",
      reason: "authentication",
    });
  });

  test("timeout e rede degradam sem lançar", async () => {
    const projectRoot = await temporaryProject();
    const resolved = resolvedFixture();
    await writeState(projectRoot, resolved);
    const timeoutChecker = createBrandUpdateChecker({
      authenticator: {
        resolveTokenSilently: (signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                reject(new DOMException("tempo esgotado", "TimeoutError"));
              },
              { once: true },
            );
          }),
      },
      resolver: {
        resolveManifest: () => Promise.resolve(resolved),
      },
      timeoutMs: 5,
    });
    expect(await timeoutChecker(projectRoot)).toMatchObject({
      kind: "unavailable",
      reason: "timeout",
    });

    const networkChecker = createBrandUpdateChecker(
      dependencies(resolved, {
        resolver: {
          resolveManifest: () =>
            Promise.reject(
              new CliError("offline", EXIT_CODES.networkWithoutCache),
            ),
        },
      }),
    );
    expect(await networkChecker(projectRoot)).toMatchObject({
      kind: "unavailable",
      reason: "network",
    });
  });

  test("CLI incompatível vira estado seguro", async () => {
    const projectRoot = await temporaryProject();
    const resolved = resolvedFixture();
    await writeState(projectRoot, resolved);
    const checker = createBrandUpdateChecker(
      dependencies(resolved, {
        resolver: {
          resolveManifest: () =>
            Promise.reject(
              new CliError("CLI antigo", EXIT_CODES.incompatibleMajor),
            ),
        },
      }),
    );

    expect(await checker(projectRoot)).toMatchObject({
      kind: "unavailable",
      reason: "cli-incompatible",
    });
  });

  test("configuração e lock inválidos não são sobrescritos", async () => {
    const projectRoot = await temporaryProject();
    const brandRoot = path.join(projectRoot, ".jerasoft");
    await mkdir(brandRoot, { recursive: true });
    const invalidConfig = '{"schemaVersion":99}\n';
    const invalidLock = '{"schemaVersion":99}\n';
    await writeFile(path.join(brandRoot, "brand.json"), invalidConfig);
    await writeFile(path.join(brandRoot, "brand.lock.json"), invalidLock);
    let externalCalls = 0;
    const resolved = resolvedFixture();
    const checker = createBrandUpdateChecker({
      authenticator: {
        resolveTokenSilently: () => {
          externalCalls += 1;
          return Promise.resolve(null);
        },
      },
      resolver: {
        resolveManifest: () => {
          externalCalls += 1;
          return Promise.resolve(resolved);
        },
      },
    });

    expect(await checker(projectRoot)).toMatchObject({
      kind: "unavailable",
    });
    expect(externalCalls).toBe(0);
    expect(await readFile(path.join(brandRoot, "brand.json"), "utf8")).toBe(
      invalidConfig,
    );
    expect(
      await readFile(path.join(brandRoot, "brand.lock.json"), "utf8"),
    ).toBe(invalidLock);
  });
});
