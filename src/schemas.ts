import { z } from "zod";

import { semverSchema } from "./semver";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const relativePathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    const segments = value.split(/[\\/]/);
    return (
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    );
  });

export const manifestPayloadSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    kind: z.enum(["contract", "skill", "asset"]),
    releaseAssetName: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    mediaType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: sha256Schema,
    version: semverSchema,
    status: z.literal("approved"),
    recommendedFilename: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional(),
  })
  .strict();

export const distributionManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolVersion: z.literal(1),
    releaseTag: z.string().regex(/^brand-kit-v\d+\.\d+\.\d+$/),
    sourceRepository: z.literal("jerasoft-co/portfolio-jerasoft"),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    generatedAt: z.iso.datetime(),
    channel: z.literal("stable"),
    minimumCliVersion: semverSchema,
    versions: z
      .object({
        bundle: semverSchema,
        contract: semverSchema,
        skills: semverSchema,
        assets: semverSchema,
      })
      .strict(),
    payloads: z.array(manifestPayloadSchema).min(1),
  })
  .strict();

export const projectConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: z.literal(1),
    channel: z.literal("stable"),
    cliRange: z.string().regex(/^\^\d+\.\d+\.\d+$/),
    contractRange: z.string().regex(/^\^\d+\.\d+\.\d+$/),
    updatePolicy: z.enum(["compatible", "frozen"]),
    agentAdapters: z.array(z.enum(["generic", "codex"])).min(1),
    assetDirectory: relativePathSchema,
  })
  .strict();

export const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseTag: z.string().regex(/^brand-kit-v\d+\.\d+\.\d+$/),
    resolvedAt: z.iso.datetime(),
    cacheState: z.enum(["fresh", "cached", "stale"]),
    versions: z
      .object({
        contract: semverSchema,
        skills: semverSchema,
        assets: semverSchema,
      })
      .strict(),
    manifestSha256: sha256Schema,
  })
  .strict();

export const projectLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: z.literal(1),
    channel: z.literal("stable"),
    releaseTag: z.string().regex(/^brand-kit-v\d+\.\d+\.\d+$/),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    resolvedAt: z.iso.datetime(),
    versions: z
      .object({
        bundle: semverSchema,
        contract: semverSchema,
        skills: semverSchema,
        assets: semverSchema,
      })
      .strict(),
    manifestSha256: sha256Schema,
    payloads: z.array(manifestPayloadSchema).min(1),
  })
  .strict();

export const cachedReleaseAssetSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    size: z.number().int().nonnegative(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const cachedReleaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    etag: z.string().min(1).nullable(),
    checkedAt: z.iso.datetime(),
    manifestSha256: sha256Schema,
    release: z
      .object({
        id: z.number().int().positive(),
        tagName: z.string().regex(/^brand-kit-v\d+\.\d+\.\d+$/),
        targetCommitish: z.string().regex(/^[a-f0-9]{40}$/),
        assets: z.array(cachedReleaseAssetSchema).min(1),
      })
      .strict(),
  })
  .strict();

export const storedCredentialSchema = z
  .object({
    schemaVersion: z.literal(1),
    accessToken: z.string().min(1),
    expiresAt: z.iso.datetime(),
    refreshToken: z.string().min(1),
    refreshExpiresAt: z.iso.datetime(),
  })
  .strict();

export type DistributionManifest = z.infer<typeof distributionManifestSchema>;
export type CachedRelease = z.infer<typeof cachedReleaseSchema>;
export type ManifestPayload = z.infer<typeof manifestPayloadSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type ProjectLock = z.infer<typeof projectLockSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type StoredCredential = z.infer<typeof storedCredentialSchema>;
