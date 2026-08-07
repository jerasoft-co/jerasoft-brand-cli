import { z } from "zod";

import {
  EXIT_CODES,
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  SOURCE_REPOSITORY,
} from "./constants";
import { CliError } from "./errors";
import { cachedReleaseAssetSchema } from "./schemas";

type HttpFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const githubReleaseSchema = z
  .object({
    id: z.number().int().positive(),
    tag_name: z.string().min(1),
    target_commitish: z.string().min(1),
    draft: z.boolean(),
    prerelease: z.boolean(),
    immutable: z.boolean(),
    assets: z.array(
      z
        .object({
          id: z.number().int().positive(),
          name: z.string().min(1),
          size: z.number().int().nonnegative(),
          digest: z.string().nullable(),
          state: z.literal("uploaded"),
        })
        .loose(),
    ),
  })
  .loose();

export interface GitHubRelease {
  id: number;
  tagName: string;
  targetCommitish: string;
  assets: z.infer<typeof cachedReleaseAssetSchema>[];
}

export type LatestReleaseResult =
  | { kind: "not-modified" }
  | { kind: "release"; release: GitHubRelease; etag: string | null };

export class GitHubRequestError extends CliError {
  constructor(
    message: string,
    exitCode:
      | typeof EXIT_CODES.authentication
      | typeof EXIT_CODES.networkWithoutCache
      | typeof EXIT_CODES.integrity,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, exitCode, options);
    this.name = "GitHubRequestError";
  }
}

function apiHeaders(token: string, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "@jerasoft/brand",
  };
}

function responseError(status: number) {
  if (status === 401 || status === 403) {
    return new GitHubRequestError(
      "O GitHub recusou o acesso. Confirme sua autorização e o acesso ao repositório da marca.",
      EXIT_CODES.authentication,
      false,
      status,
    );
  }
  if (status >= 500 || status === 429) {
    return new GitHubRequestError(
      `O GitHub está temporariamente indisponível (HTTP ${String(status)}).`,
      EXIT_CODES.networkWithoutCache,
      true,
      status,
    );
  }
  return new GitHubRequestError(
    `A resposta do GitHub não corresponde ao protocolo esperado (HTTP ${String(status)}).`,
    EXIT_CODES.integrity,
    false,
    status,
  );
}

function validateRelease(raw: unknown): GitHubRelease {
  const release = githubReleaseSchema.safeParse(raw);
  if (!release.success) {
    throw new GitHubRequestError(
      "A release retornada pelo GitHub possui formato incompatível.",
      EXIT_CODES.integrity,
      false,
    );
  }
  if (
    release.data.draft ||
    release.data.prerelease ||
    !release.data.immutable
  ) {
    throw new GitHubRequestError(
      "A release da marca precisa estar publicada, estável e imutável.",
      EXIT_CODES.integrity,
      false,
    );
  }
  const assets = release.data.assets.map((asset) =>
    cachedReleaseAssetSchema.parse({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      digest: asset.digest,
    }),
  );
  return {
    id: release.data.id,
    tagName: release.data.tag_name,
    targetCommitish: release.data.target_commitish,
    assets,
  };
}

function isAllowedDownloadHost(hostname: string) {
  return (
    hostname === "objects.githubusercontent.com" ||
    hostname === "release-assets.githubusercontent.com" ||
    hostname.endsWith(".githubusercontent.com")
  );
}

export class GitHubClient {
  constructor(private readonly fetcher: HttpFetcher = fetch) {}

  async latestRelease(
    token: string,
    etag?: string | null,
  ): Promise<LatestReleaseResult> {
    const headers: Record<string, string> = apiHeaders(token);
    if (etag) headers["If-None-Match"] = etag;

    let response: Response;
    try {
      response = await this.fetcher(
        `${GITHUB_API_ORIGIN}/repos/${SOURCE_REPOSITORY}/releases/latest`,
        { headers, redirect: "manual" },
      );
    } catch (error) {
      throw new GitHubRequestError(
        "Não foi possível consultar a release da marca no GitHub.",
        EXIT_CODES.networkWithoutCache,
        true,
        undefined,
        { cause: error },
      );
    }
    if (response.status === 304) return { kind: "not-modified" };
    if (!response.ok) throw responseError(response.status);
    return {
      kind: "release",
      release: validateRelease(await response.json()),
      etag: response.headers.get("etag"),
    };
  }

  async downloadAsset(token: string, assetId: number) {
    let response: Response;
    try {
      response = await this.fetcher(
        `${GITHUB_API_ORIGIN}/repos/${SOURCE_REPOSITORY}/releases/assets/${String(assetId)}`,
        {
          headers: apiHeaders(token, "application/octet-stream"),
          redirect: "manual",
        },
      );
    } catch (error) {
      throw new GitHubRequestError(
        "Não foi possível baixar um arquivo da marca no GitHub.",
        EXIT_CODES.networkWithoutCache,
        true,
        undefined,
        { cause: error },
      );
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      let downloadUrl: URL;
      try {
        downloadUrl = new URL(location ?? "");
      } catch {
        throw new GitHubRequestError(
          "O GitHub retornou um destino de download inválido.",
          EXIT_CODES.integrity,
          false,
        );
      }
      if (
        downloadUrl.protocol !== "https:" ||
        !isAllowedDownloadHost(downloadUrl.hostname)
      ) {
        throw new GitHubRequestError(
          "O GitHub retornou um host de download não autorizado.",
          EXIT_CODES.integrity,
          false,
        );
      }
      try {
        response = await this.fetcher(downloadUrl, { redirect: "error" });
      } catch (error) {
        throw new GitHubRequestError(
          "Não foi possível concluir o download verificado da marca.",
          EXIT_CODES.networkWithoutCache,
          true,
          undefined,
          { cause: error },
        );
      }
    }

    if (!response.ok) throw responseError(response.status);
    return new Uint8Array(await response.arrayBuffer());
  }
}
