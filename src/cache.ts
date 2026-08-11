import { homedir } from "node:os";
import path from "node:path";
import { lstat, rm } from "node:fs/promises";

import packageMetadata from "../package.json" with { type: "json" };

import { CACHE_MAX_AGE_MS, EXIT_CODES, MANIFEST_ASSET_NAME } from "./constants";
import { CliError } from "./errors";
import { GitHubClient, GitHubRequestError, type GitHubRelease } from "./github";
import {
  cachedReleaseSchema,
  distributionManifestSchema,
  receiptSchema,
  type CachedRelease,
  type DistributionManifest,
  type ManifestPayload,
  type Receipt,
} from "./schemas";
import {
  atomicWriteFile,
  pathExists,
  readRegularFile,
  sha256,
  verifyFile,
} from "./security";
import { compareSemver } from "./semver";

function serialize(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function defaultCacheRoot(
  environment: Record<string, string | undefined> = process.env,
) {
  const explicit = environment.JERASOFT_BRAND_CACHE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Caches", "JeraSoft", "brand-cli");
  }
  if (process.platform === "win32") {
    return path.join(
      environment.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "JeraSoft",
      "brand-cli",
    );
  }
  return path.join(
    environment.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"),
    "jerasoft",
    "brand-cli",
  );
}

export class CacheStore {
  constructor(readonly root = defaultCacheRoot()) {}

  private get latestPath() {
    return path.join(this.root, "stable.json");
  }

  manifestPath(releaseTag: string) {
    return path.join(this.root, "releases", releaseTag, MANIFEST_ASSET_NAME);
  }

  payloadPath(releaseTag: string, releaseAssetName: string) {
    return path.join(
      this.root,
      "releases",
      releaseTag,
      "payloads",
      releaseAssetName,
    );
  }

  async loadLatest() {
    const contents = await readRegularFile(this.latestPath);
    if (!contents) return null;
    try {
      return cachedReleaseSchema.parse(
        JSON.parse(contents.toString()) as unknown,
      );
    } catch (error) {
      throw new CliError(
        "O índice local da marca está corrompido.",
        EXIT_CODES.integrity,
        { cause: error },
      );
    }
  }

  async saveLatest(state: CachedRelease) {
    await atomicWriteFile(
      this.latestPath,
      serialize(cachedReleaseSchema.parse(state)),
    );
  }

  async loadManifest(state: CachedRelease) {
    const manifestAsset = state.release.assets.find(
      (asset) => asset.name === MANIFEST_ASSET_NAME,
    );
    if (!manifestAsset) return null;
    const contents = await verifyFile(
      this.manifestPath(state.release.tagName),
      manifestAsset.size,
      state.manifestSha256,
    );
    if (!contents) return null;
    try {
      return {
        contents,
        manifest: distributionManifestSchema.parse(
          JSON.parse(contents.toString()) as unknown,
        ),
      };
    } catch (error) {
      throw new CliError(
        "O manifesto local da marca está corrompido.",
        EXIT_CODES.integrity,
        { cause: error },
      );
    }
  }

  async saveManifest(releaseTag: string, contents: Uint8Array) {
    await atomicWriteFile(this.manifestPath(releaseTag), contents);
  }

  async loadPayload(releaseTag: string, payload: ManifestPayload) {
    return verifyFile(
      this.payloadPath(releaseTag, payload.releaseAssetName),
      payload.bytes,
      payload.sha256,
    );
  }

  async savePayload(
    releaseTag: string,
    payload: ManifestPayload,
    contents: Uint8Array,
  ) {
    await atomicWriteFile(
      this.payloadPath(releaseTag, payload.releaseAssetName),
      contents,
    );
  }

  async saveReceipt(profile: string, receipt: Receipt) {
    await atomicWriteFile(
      path.join(this.root, "receipts", `${profile}.json`),
      serialize(receiptSchema.parse(receipt)),
    );
  }

  async purge() {
    const resolved = path.resolve(this.root);
    if (
      resolved === path.parse(resolved).root ||
      resolved === path.resolve(homedir()) ||
      resolved === path.resolve(process.cwd()) ||
      path.dirname(resolved) === resolved
    ) {
      throw new CliError(
        "O diretório de cache configurado é amplo demais para remoção segura.",
        EXIT_CODES.integrity,
      );
    }
    if (!(await pathExists(resolved))) return;
    const entry = await lstat(resolved);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new CliError(
        "O cache configurado não aponta para um diretório seguro.",
        EXIT_CODES.integrity,
      );
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

export interface ResolvedManifest {
  manifest: DistributionManifest;
  manifestSha256: string;
  release: GitHubRelease;
  cacheState: "fresh" | "cached" | "stale";
}

function validateManifest(
  manifest: DistributionManifest,
  manifestSha256: string,
  release: GitHubRelease,
) {
  if (
    manifest.releaseTag !== release.tagName ||
    manifest.sourceCommit !== release.targetCommitish
  ) {
    throw new CliError(
      "A proveniência do manifesto diverge da release publicada.",
      EXIT_CODES.integrity,
    );
  }
  if (compareSemver(packageMetadata.version, manifest.minimumCliVersion) < 0) {
    throw new CliError(
      `Esta release requer ${packageMetadata.name}@${manifest.minimumCliVersion} ou superior.`,
      EXIT_CODES.incompatibleMajor,
    );
  }

  const expectedNames = new Set([
    MANIFEST_ASSET_NAME,
    ...manifest.payloads.map((payload) => payload.releaseAssetName),
  ]);
  if (
    expectedNames.size !== manifest.payloads.length + 1 ||
    release.assets.length !== expectedNames.size ||
    release.assets.some((asset) => !expectedNames.has(asset.name))
  ) {
    throw new CliError(
      "A lista de arquivos da release diverge do manifesto aprovado.",
      EXIT_CODES.integrity,
    );
  }

  const manifestAsset = release.assets.find(
    (asset) => asset.name === MANIFEST_ASSET_NAME,
  );
  if (manifestAsset?.digest !== `sha256:${manifestSha256}`) {
    throw new CliError(
      "O digest do manifesto diverge da API do GitHub.",
      EXIT_CODES.integrity,
    );
  }
  for (const payload of manifest.payloads) {
    const asset = release.assets.find(
      (candidate) => candidate.name === payload.releaseAssetName,
    );
    if (
      asset?.size !== payload.bytes ||
      asset.digest !== `sha256:${payload.sha256}`
    ) {
      throw new CliError(
        `A release diverge do manifesto para ${payload.id}.`,
        EXIT_CODES.integrity,
      );
    }
  }
}

function isWithinStaleWindow(state: CachedRelease, now: Date) {
  const checkedAt = Date.parse(state.checkedAt);
  return (
    Number.isFinite(checkedAt) && now.getTime() - checkedAt <= CACHE_MAX_AGE_MS
  );
}

export class BrandResolver {
  constructor(
    private readonly cache: CacheStore,
    private readonly github: GitHubClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolveManifest(options: {
    token?: string;
    fresh?: boolean;
    offline?: boolean;
    signal?: AbortSignal;
  }): Promise<ResolvedManifest> {
    const cached = await this.cache.loadLatest();
    if (options.offline) {
      return this.cachedFallback(cached, "stale");
    }
    if (!options.token) {
      throw new CliError(
        "A autenticação é obrigatória para consultar a marca.",
        EXIT_CODES.authentication,
      );
    }

    let latest;
    try {
      latest = await this.github.latestRelease(
        options.token,
        cached?.etag,
        options.signal,
      );
    } catch (error) {
      if (
        !options.fresh &&
        error instanceof GitHubRequestError &&
        error.retryable
      ) {
        return this.cachedFallback(cached, "stale");
      }
      throw error;
    }

    if (latest.kind === "not-modified") {
      const resolved = await this.cachedFallback(cached, "cached");
      await this.cache.saveLatest({
        ...cachedReleaseSchema.parse(cached),
        checkedAt: this.now().toISOString(),
      });
      return resolved;
    }

    const manifestAsset = latest.release.assets.find(
      (asset) => asset.name === MANIFEST_ASSET_NAME,
    );
    if (!manifestAsset) {
      throw new CliError(
        "A release não contém manifest.json.",
        EXIT_CODES.integrity,
      );
    }
    const manifestDigest = manifestAsset.digest.slice("sha256:".length);

    let manifestContents: Uint8Array | null = null;
    let manifest: DistributionManifest | null = null;
    if (
      cached?.release.id === latest.release.id &&
      cached.manifestSha256 === manifestDigest
    ) {
      const local = await this.cache.loadManifest(cached);
      manifestContents = local?.contents ?? null;
      manifest = local?.manifest ?? null;
    }
    if (!manifestContents || !manifest) {
      manifestContents = await this.github.downloadAsset(
        options.token,
        manifestAsset.id,
        options.signal,
      );
      if (
        manifestContents.byteLength !== manifestAsset.size ||
        sha256(manifestContents) !== manifestDigest
      ) {
        throw new CliError(
          "O manifesto baixado não corresponde ao digest publicado.",
          EXIT_CODES.integrity,
        );
      }
      try {
        manifest = distributionManifestSchema.parse(
          JSON.parse(Buffer.from(manifestContents).toString("utf8")) as unknown,
        );
      } catch (error) {
        throw new CliError(
          "O manifesto baixado possui conteúdo inválido.",
          EXIT_CODES.integrity,
          { cause: error },
        );
      }
    }

    validateManifest(manifest, manifestDigest, latest.release);
    const state = cachedReleaseSchema.parse({
      schemaVersion: 1,
      etag: latest.etag,
      checkedAt: this.now().toISOString(),
      manifestSha256: manifestDigest,
      release: latest.release,
    });
    await this.cache.saveManifest(latest.release.tagName, manifestContents);
    await this.cache.saveLatest(state);
    return {
      manifest,
      manifestSha256: manifestDigest,
      release: latest.release,
      cacheState: "fresh",
    };
  }

  async resolvePayload(
    resolved: ResolvedManifest,
    payload: ManifestPayload,
    token?: string,
    offline = false,
  ) {
    const cached = await this.cache.loadPayload(
      resolved.release.tagName,
      payload,
    );
    if (cached) return cached;
    if (offline || !token) {
      throw new CliError(
        `O payload ${payload.id} não está disponível no cache offline.`,
        EXIT_CODES.networkWithoutCache,
      );
    }
    const asset = resolved.release.assets.find(
      (candidate) => candidate.name === payload.releaseAssetName,
    );
    if (!asset) {
      throw new CliError(
        `A release não contém o payload ${payload.id}.`,
        EXIT_CODES.integrity,
      );
    }
    const contents = await this.github.downloadAsset(token, asset.id);
    if (
      contents.byteLength !== payload.bytes ||
      sha256(contents) !== payload.sha256
    ) {
      throw new CliError(
        `O payload ${payload.id} não corresponde ao digest aprovado.`,
        EXIT_CODES.integrity,
      );
    }
    await this.cache.savePayload(resolved.release.tagName, payload, contents);
    return contents;
  }

  private async cachedFallback(
    cached: CachedRelease | null,
    cacheState: "cached" | "stale",
  ): Promise<ResolvedManifest> {
    if (!cached || !isWithinStaleWindow(cached, this.now())) {
      throw new CliError(
        "Não há cache íntegro e recente para concluir a operação.",
        EXIT_CODES.networkWithoutCache,
      );
    }
    const local = await this.cache.loadManifest(cached);
    if (!local) {
      throw new CliError(
        "O manifesto não está disponível no cache íntegro.",
        EXIT_CODES.networkWithoutCache,
      );
    }
    validateManifest(local.manifest, cached.manifestSha256, cached.release);
    return {
      manifest: local.manifest,
      manifestSha256: cached.manifestSha256,
      release: cached.release,
      cacheState,
    };
  }
}
