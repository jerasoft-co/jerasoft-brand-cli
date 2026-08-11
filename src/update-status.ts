import path from "node:path";

import { GitHubAuthenticator, type ResolvedToken } from "./auth";
import { BrandResolver, CacheStore, type ResolvedManifest } from "./cache";
import { EXIT_CODES, INTERACTIVE_UPDATE_TIMEOUT_MS } from "./constants";
import { CliError } from "./errors";
import { GitHubClient } from "./github";
import {
  loadProjectConfig,
  loadProjectLock,
  lockMatchesManifest,
} from "./project";
import type { DistributionManifest, ProjectLock } from "./schemas";
import { pathExists } from "./security";
import { compareSemver, parseSemver } from "./semver";

export type BrandUpdateStatus =
  | { kind: "not-initialized" }
  | { kind: "lock-missing" }
  | {
      kind: "current" | "update-available" | "major-update" | "local-ahead";
      installed: ProjectLock["versions"];
      available: DistributionManifest["versions"];
      releaseTag: string;
      cacheState: ResolvedManifest["cacheState"];
    }
  | {
      kind: "unavailable";
      installed?: ProjectLock["versions"];
      reason:
        | "authentication"
        | "network"
        | "timeout"
        | "configuration"
        | "integrity"
        | "cli-incompatible";
    };

export type BrandUpdateChecker = (
  projectRoot: string,
) => Promise<BrandUpdateStatus>;

export interface SilentTokenResolver {
  resolveTokenSilently(signal?: AbortSignal): Promise<ResolvedToken | null>;
}

export interface UpdateManifestResolver {
  resolveManifest(options: {
    token?: string;
    offline?: boolean;
    signal?: AbortSignal;
  }): Promise<ResolvedManifest>;
}

export interface BrandUpdateDependencies {
  authenticator: SilentTokenResolver;
  resolver: UpdateManifestResolver;
  timeoutMs?: number;
}

function defaultDependencies(): BrandUpdateDependencies {
  const cache = new CacheStore();
  return {
    authenticator: new GitHubAuthenticator({
      stdout: () => undefined,
      stderr: () => undefined,
    }),
    resolver: new BrandResolver(cache, new GitHubClient()),
  };
}

function unavailableReason(
  error: unknown,
  signal: AbortSignal,
  withoutToken: boolean,
): Extract<BrandUpdateStatus, { kind: "unavailable" }>["reason"] {
  if (signal.aborted) return "timeout";
  if (!(error instanceof CliError)) return "configuration";
  if (error.exitCode === EXIT_CODES.authentication) return "authentication";
  if (error.exitCode === EXIT_CODES.networkWithoutCache) {
    return withoutToken ? "authentication" : "network";
  }
  if (error.exitCode === EXIT_CODES.integrity) return "integrity";
  if (error.exitCode === EXIT_CODES.incompatibleMajor) {
    return "cli-incompatible";
  }
  return "configuration";
}

async function resolveBrandUpdate(
  projectRoot: string,
  dependencies: BrandUpdateDependencies,
): Promise<BrandUpdateStatus> {
  if (!(await pathExists(path.join(projectRoot, ".jerasoft", "brand.json")))) {
    return { kind: "not-initialized" };
  }
  if (
    !(await pathExists(path.join(projectRoot, ".jerasoft", "brand.lock.json")))
  ) {
    return { kind: "lock-missing" };
  }

  let installed: ProjectLock["versions"] | undefined;
  const signal = AbortSignal.timeout(
    dependencies.timeoutMs ?? INTERACTIVE_UPDATE_TIMEOUT_MS,
  );
  let withoutToken = false;
  try {
    const [config, lock] = await Promise.all([
      loadProjectConfig(projectRoot),
      loadProjectLock(projectRoot),
    ]);
    installed = lock.versions;
    const authentication =
      await dependencies.authenticator.resolveTokenSilently(signal);
    withoutToken = authentication === null;
    const resolved = authentication
      ? await dependencies.resolver.resolveManifest({
          token: authentication.token,
          signal,
        })
      : await dependencies.resolver.resolveManifest({ offline: true, signal });
    const shared = {
      installed: lock.versions,
      available: resolved.manifest.versions,
      releaseTag: resolved.manifest.releaseTag,
      cacheState: resolved.cacheState,
    };

    if (lockMatchesManifest(lock, resolved)) {
      return { kind: "current", ...shared };
    }

    const availableMajor = parseSemver(
      resolved.manifest.versions.contract,
    ).major;
    const configuredMajor = parseSemver(config.contractRange.slice(1)).major;
    if (availableMajor !== configuredMajor) {
      return { kind: "major-update", ...shared };
    }
    if (
      compareSemver(resolved.manifest.versions.bundle, lock.versions.bundle) < 0
    ) {
      return { kind: "local-ahead", ...shared };
    }
    return { kind: "update-available", ...shared };
  } catch (error) {
    return {
      kind: "unavailable",
      ...(installed ? { installed } : {}),
      reason: unavailableReason(error, signal, withoutToken),
    };
  }
}

export function createBrandUpdateChecker(
  dependencies: BrandUpdateDependencies = defaultDependencies(),
): BrandUpdateChecker {
  return (projectRoot) => resolveBrandUpdate(projectRoot, dependencies);
}

export const defaultBrandUpdateChecker = createBrandUpdateChecker();

export function checkBrandUpdate(projectRoot: string) {
  return defaultBrandUpdateChecker(projectRoot);
}
