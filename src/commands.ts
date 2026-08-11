import path from "node:path";

import type { CliCommand, Profile } from "./arguments";
import { GitHubAuthenticator } from "./auth";
import { BrandResolver, CacheStore, type ResolvedManifest } from "./cache";
import { EXIT_CODES } from "./constants";
import { CliError } from "./errors";
import { GitHubClient } from "./github";
import type { CliIo } from "./io";
import {
  assertCompatible,
  auditTokenPayload,
  configuredTokenPayloadIds,
  createDefaultConfig,
  initializeProject,
  inspectProject,
  loadProjectConfig,
  loadProjectLock,
  lockFromResolved,
  lockMatchesManifest,
  materializeAsset,
  materializeTokenPayload,
  writeProjectConfig,
  writeProjectLock,
} from "./project";
import {
  receiptSchema,
  type ManifestPayload,
  type ProjectConfig,
  type TokenAdapter,
} from "./schemas";
import { pathExists } from "./security";

export interface CommandRuntime {
  projectRoot: string;
  cache: CacheStore;
  authenticator: GitHubAuthenticator;
  resolver: BrandResolver;
  now: () => Date;
}

export function createDefaultRuntime(io: CliIo): CommandRuntime {
  const cache = new CacheStore();
  return {
    projectRoot: process.cwd(),
    cache,
    authenticator: new GitHubAuthenticator(io),
    resolver: new BrandResolver(cache, new GitHubClient()),
    now: () => new Date(),
  };
}

async function resolveOnline(
  runtime: CommandRuntime,
  fresh = false,
): Promise<{ resolved: ResolvedManifest; token: string }> {
  const authentication = await runtime.authenticator.resolveToken();
  const resolved = await runtime.resolver.resolveManifest({
    token: authentication.token,
    fresh,
  });
  return { resolved, token: authentication.token };
}

async function materializeConfiguredTokens(
  runtime: CommandRuntime,
  config: ProjectConfig,
  resolved: ResolvedManifest,
  token: string,
  previousLock: Awaited<ReturnType<typeof loadProjectLock>> | null,
) {
  const descriptors = configuredTokenPayloadIds(config).map((id) => {
    const payload = resolved.manifest.payloads.find(
      (candidate) => candidate.id === id && candidate.kind === "contract",
    );
    if (!payload) {
      throw new CliError(
        `A release não contém o payload de tokens ${id}.`,
        EXIT_CODES.integrity,
      );
    }
    return payload;
  });
  const contents = await Promise.all(
    descriptors.map((payload) =>
      runtime.resolver.resolvePayload(resolved, payload, token),
    ),
  );
  const results = await Promise.all(
    descriptors.map((payload, index) => {
      const payloadContents = contents.at(index);
      if (!payloadContents) {
        throw new CliError(
          `O conteúdo do payload ${payload.id} não foi resolvido.`,
          EXIT_CODES.integrity,
        );
      }
      return materializeTokenPayload(
        runtime.projectRoot,
        config,
        payload,
        payloadContents,
        previousLock?.payloads.find((candidate) => candidate.id === payload.id),
      );
    }),
  );
  return results.filter((result) => result.changed).length;
}

function payloadForProfile(
  resolved: ResolvedManifest,
  profile: Profile,
): ManifestPayload {
  const id =
    profile === "apply"
      ? "skill.jerasoft-apply-brand"
      : profile === "audit"
        ? "skill.jerasoft-audit-interface"
        : "skill.jerasoft-resolve-assets";
  const payload = resolved.manifest.payloads.find(
    (candidate) => candidate.id === id && candidate.kind === "skill",
  );
  if (!payload) {
    throw new CliError(
      `A release não contém a skill aprovada para o perfil ${profile}.`,
      EXIT_CODES.integrity,
    );
  }
  return payload;
}

function contractPayload(resolved: ResolvedManifest) {
  const payload = resolved.manifest.payloads.find(
    (candidate) => candidate.id === "contract.jerasoft-ui",
  );
  if (payload?.kind !== "contract") {
    throw new CliError(
      "A release não contém o contrato de interface aprovado.",
      EXIT_CODES.integrity,
    );
  }
  return payload;
}

function markdownContext(
  resolved: ResolvedManifest,
  profile: Profile,
  contract: string,
  skill: string,
) {
  const assets = resolved.manifest.payloads
    .filter((payload) => payload.kind === "asset")
    .map(
      (payload) =>
        `- \`${payload.id}\` — \`${payload.recommendedFilename ?? payload.releaseAssetName}\` — sha256:${payload.sha256}`,
    )
    .join("\n");
  const assetSection =
    profile === "assets"
      ? `\n\n## Ativos aprovados nesta release\n\n${assets}`
      : "";
  return `# Contexto JeraSoft resolvido

- Release: \`${resolved.manifest.releaseTag}\`
- Contrato: \`${resolved.manifest.versions.contract}\`
- Skills: \`${resolved.manifest.versions.skills}\`
- Assets: \`${resolved.manifest.versions.assets}\`
- Manifesto: \`sha256:${resolved.manifestSha256}\`
- Cache: \`${resolved.cacheState}\`

## Contrato vigente

${contract.trim()}

## Procedimento do perfil ${profile}

${skill.trim()}${assetSection}
`;
}

async function commandInit(
  command: Extract<CliCommand, { kind: "init" }>,
  io: CliIo,
  runtime: CommandRuntime,
) {
  const inspection = await inspectProject(runtime.projectRoot);
  const configPath = path.join(runtime.projectRoot, ".jerasoft", "brand.json");
  const existingConfig = (await pathExists(configPath))
    ? await loadProjectConfig(runtime.projectRoot)
    : null;
  const baseConfig = existingConfig
    ? command.artifacts
      ? { ...existingConfig, agentArtifacts: command.artifacts }
      : existingConfig
    : createDefaultConfig(command.artifacts);
  const detectedAdapters: TokenAdapter[] = [];
  if (
    inspection.signals.some((signal) =>
      new Set(["Next.js", "Vite"]).has(signal),
    )
  ) {
    detectedAdapters.push("css");
  }
  if (inspection.signals.includes("Delphi VCL")) {
    detectedAdapters.push("delphi-vcl");
  }
  if (inspection.signals.includes("Delphi FMX")) {
    detectedAdapters.push("delphi-fmx");
  }
  const config: ProjectConfig = {
    ...baseConfig,
    appearance: {
      ...baseConfig.appearance,
      default: command.appearance ?? baseConfig.appearance.default,
    },
    tokens: {
      ...baseConfig.tokens,
      adapters:
        command.tokenAdapters ??
        (existingConfig ? baseConfig.tokens.adapters : detectedAdapters),
      outputDirectory: command.tokenOutput ?? baseConfig.tokens.outputDirectory,
    },
  };
  if (
    config.agentArtifacts.includes("instructions") &&
    inspection.agentsFile === "invalid-managed-block"
  ) {
    throw new CliError(
      "O AGENTS.md contém um bloco JeraSoft incompleto ou duplicado. Corrija os marcadores antes de inicializar.",
      EXIT_CODES.integrity,
    );
  }
  if (
    config.agentArtifacts.includes("skills") &&
    inspection.agentSkills.state === "conflict"
  ) {
    throw new CliError(
      "Uma Agent Skill JeraSoft já existe, mas não é gerenciada pelo CLI. Preserve ou renomeie o arquivo antes de inicializar.",
      EXIT_CODES.integrity,
    );
  }
  if (command.dryRun) {
    const projectType = inspection.existingProject
      ? "projeto existente"
      : "diretório novo";
    const agentsPlan =
      inspection.agentsFile === "absent"
        ? "criar AGENTS.md"
        : inspection.agentsFile === "existing"
          ? "preservar AGENTS.md e acrescentar o bloco JeraSoft"
          : "atualizar somente o bloco JeraSoft de AGENTS.md";
    io.stdout(
      `Inicialização planejada sem escrita para ${projectType}: criar ou atualizar .jerasoft/brand.json e .jerasoft/brand.lock.json${config.agentArtifacts.includes("instructions") ? `; ${agentsPlan}` : ""}${config.agentArtifacts.includes("skills") ? "; criar ou atualizar três Agent Skills abertas em .agents/skills" : ""}.`,
    );
    return EXIT_CODES.success;
  }

  const { resolved, token } = await resolveOnline(runtime, true);
  assertCompatible(config, resolved);
  const previousLock = inspection.brandLockPresent
    ? await loadProjectLock(runtime.projectRoot)
    : null;
  const materialized = await materializeConfiguredTokens(
    runtime,
    config,
    resolved,
    token,
    previousLock,
  );
  await initializeProject(
    runtime.projectRoot,
    config,
    lockFromResolved(resolved, runtime.now()),
  );
  const action = inspection.brandInitialized
    ? "Integração reconciliada"
    : inspection.existingProject
      ? "Projeto existente integrado"
      : "Projeto inicializado";
  const preservation =
    config.agentArtifacts.includes("instructions") &&
    inspection.agentsFile === "existing"
      ? " O conteúdo anterior de AGENTS.md foi preservado."
      : "";
  io.stdout(
    `${action} com ${resolved.manifest.releaseTag} e contrato ${resolved.manifest.versions.contract}; ${String(materialized)} arquivo(s) de tokens atualizado(s).${preservation}`,
  );
  return EXIT_CODES.success;
}

async function commandContext(
  command: Extract<CliCommand, { kind: "context" }>,
  io: CliIo,
  runtime: CommandRuntime,
) {
  const config = await loadProjectConfig(runtime.projectRoot);
  const { resolved, token } = await resolveOnline(runtime, command.fresh);
  assertCompatible(config, resolved);
  const contractDescriptor = contractPayload(resolved);
  const skillDescriptor = payloadForProfile(resolved, command.profile);
  const [contractBytes, skillBytes] = await Promise.all([
    runtime.resolver.resolvePayload(resolved, contractDescriptor, token),
    runtime.resolver.resolvePayload(resolved, skillDescriptor, token),
  ]);
  const contract = Buffer.from(contractBytes).toString("utf8");
  const skill = Buffer.from(skillBytes).toString("utf8");

  const receipt = receiptSchema.parse({
    schemaVersion: 1,
    releaseTag: resolved.manifest.releaseTag,
    resolvedAt: runtime.now().toISOString(),
    cacheState: resolved.cacheState,
    versions: {
      contract: resolved.manifest.versions.contract,
      skills: resolved.manifest.versions.skills,
      assets: resolved.manifest.versions.assets,
    },
    manifestSha256: resolved.manifestSha256,
  });
  await runtime.cache.saveReceipt(command.profile, receipt);

  if (command.format === "json") {
    io.stdout(
      JSON.stringify(
        {
          receipt,
          profile: command.profile,
          contract,
          skill,
          assets:
            command.profile === "assets"
              ? resolved.manifest.payloads.filter(
                  (payload) => payload.kind === "asset",
                )
              : undefined,
        },
        null,
        2,
      ),
    );
  } else {
    io.stdout(markdownContext(resolved, command.profile, contract, skill));
  }
  return EXIT_CODES.success;
}

async function commandAsset(
  command: Extract<CliCommand, { kind: "asset" }>,
  io: CliIo,
  runtime: CommandRuntime,
) {
  const config = await loadProjectConfig(runtime.projectRoot);
  const { resolved, token } = await resolveOnline(runtime, command.fresh);
  assertCompatible(config, resolved);
  const payload = resolved.manifest.payloads.find(
    (candidate) => candidate.kind === "asset" && candidate.id === command.id,
  );
  if (!payload) {
    throw new CliError(
      `Não existe ativo aprovado com o ID ${command.id}.`,
      EXIT_CODES.usageOrConfiguration,
    );
  }
  const contents = await runtime.resolver.resolvePayload(
    resolved,
    payload,
    token,
  );
  const result = await materializeAsset(
    runtime.projectRoot,
    config,
    command.copyTo,
    payload,
    contents,
  );
  await writeProjectLock(
    runtime.projectRoot,
    lockFromResolved(resolved, runtime.now()),
  );
  io.stdout(
    `${result.changed ? "Ativo materializado" : "Ativo já estava íntegro"}: ${command.copyTo} (${payload.id}, sha256:${payload.sha256}).`,
  );
  return EXIT_CODES.success;
}

async function verifyCachedPayloads(
  runtime: CommandRuntime,
  resolved: ResolvedManifest,
) {
  let verified = 0;
  for (const payload of resolved.manifest.payloads) {
    const payloadPath = runtime.cache.payloadPath(
      resolved.manifest.releaseTag,
      payload.releaseAssetName,
    );
    if (!(await pathExists(payloadPath))) continue;
    const contents = await runtime.cache.loadPayload(
      resolved.manifest.releaseTag,
      payload,
    );
    if (!contents) {
      throw new CliError(
        `O payload em cache diverge do digest: ${payload.id}.`,
        EXIT_CODES.integrity,
      );
    }
    verified += 1;
  }
  return verified;
}

async function commandAudit(
  command: Extract<CliCommand, { kind: "audit" }>,
  io: CliIo,
  runtime: CommandRuntime,
) {
  const [config, lock] = await Promise.all([
    loadProjectConfig(runtime.projectRoot),
    loadProjectLock(runtime.projectRoot),
  ]);
  const resolved = command.offline
    ? await runtime.resolver.resolveManifest({ offline: true })
    : (await resolveOnline(runtime)).resolved;
  assertCompatible(config, resolved);
  const matches = lockMatchesManifest(lock, resolved);
  if (command.frozen && !matches) {
    throw new CliError(
      "O lock da marca diverge da resolução vigente.",
      EXIT_CODES.drift,
    );
  }
  const verifiedPayloads = await verifyCachedPayloads(runtime, resolved);
  const tokenDescriptors = configuredTokenPayloadIds(config).map((id) =>
    resolved.manifest.payloads.find((payload) => payload.id === id),
  );
  if (tokenDescriptors.some((payload) => !payload)) {
    throw new CliError(
      "A release não contém todos os adapters de tokens configurados.",
      EXIT_CODES.integrity,
    );
  }
  const presentTokenDescriptors = tokenDescriptors.filter(
    (payload): payload is ManifestPayload => payload !== undefined,
  );
  const tokenChecks = await Promise.all(
    presentTokenDescriptors.map((payload) =>
      auditTokenPayload(runtime.projectRoot, config, payload),
    ),
  );
  if (tokenChecks.some((valid) => !valid)) {
    throw new CliError(
      "Os arquivos de tokens materializados estão ausentes ou divergentes.",
      EXIT_CODES.drift,
    );
  }
  io.stdout(
    `Auditoria concluída: lock ${matches ? "íntegro" : "com atualização disponível"}, manifesto sha256:${resolved.manifestSha256}, ${String(verifiedPayloads)} payload(s) em cache e ${String(tokenChecks.length)} arquivo(s) de tokens verificado(s).`,
  );
  return EXIT_CODES.success;
}

async function commandSync(
  command: Extract<CliCommand, { kind: "sync" }>,
  io: CliIo,
  runtime: CommandRuntime,
) {
  const config = await loadProjectConfig(runtime.projectRoot);
  const inspection = await inspectProject(runtime.projectRoot);
  if (
    config.agentArtifacts.includes("instructions") &&
    inspection.agentsFile === "invalid-managed-block"
  ) {
    throw new CliError(
      "O AGENTS.md contém um bloco JeraSoft incompleto. Corrija os marcadores antes de sincronizar.",
      EXIT_CODES.integrity,
    );
  }
  if (
    config.agentArtifacts.includes("skills") &&
    inspection.agentSkills.state === "conflict"
  ) {
    throw new CliError(
      "Uma Agent Skill JeraSoft existente não é gerenciada pelo CLI. Preserve ou renomeie o arquivo antes de sincronizar.",
      EXIT_CODES.integrity,
    );
  }
  const { resolved, token } = await resolveOnline(runtime, command.fresh);
  assertCompatible(config, resolved);
  const previousLock = (await pathExists(
    path.join(runtime.projectRoot, ".jerasoft", "brand.lock.json"),
  ))
    ? await loadProjectLock(runtime.projectRoot)
    : null;
  const materialized = await materializeConfiguredTokens(
    runtime,
    config,
    resolved,
    token,
    previousLock,
  );
  await initializeProject(
    runtime.projectRoot,
    config,
    lockFromResolved(resolved, runtime.now()),
  );
  io.stdout(
    `Configuração, lock, tokens e artefatos de agente sincronizados com ${resolved.manifest.releaseTag}; ${String(materialized)} arquivo(s) de tokens atualizado(s).`,
  );
  return EXIT_CODES.success;
}

async function commandUpgrade(
  command: Extract<CliCommand, { kind: "upgrade" }>,
  io: CliIo,
  runtime: CommandRuntime,
) {
  if (!command.major) {
    throw new CliError(
      "Mudanças major exigem a opção explícita --major.",
      EXIT_CODES.usageOrConfiguration,
    );
  }
  const config = await loadProjectConfig(runtime.projectRoot);
  const { resolved } = await resolveOnline(runtime, true);
  const upgraded: ProjectConfig = {
    ...config,
    contractRange: `^${resolved.manifest.versions.contract}`,
  };
  await writeProjectConfig(runtime.projectRoot, upgraded);
  await writeProjectLock(
    runtime.projectRoot,
    lockFromResolved(resolved, runtime.now()),
  );
  io.stdout(
    `Migração major registrada para o contrato ${resolved.manifest.versions.contract}.`,
  );
  return EXIT_CODES.success;
}

export async function executeCommand(
  command: CliCommand,
  io: CliIo,
  runtime: CommandRuntime = createDefaultRuntime(io),
) {
  switch (command.kind) {
    case "init":
      return commandInit(command, io, runtime);
    case "context":
      return commandContext(command, io, runtime);
    case "asset":
      return commandAsset(command, io, runtime);
    case "audit":
      return commandAudit(command, io, runtime);
    case "sync":
      return commandSync(command, io, runtime);
    case "upgrade":
      return commandUpgrade(command, io, runtime);
    case "logout":
      await runtime.authenticator.logout();
      if (command.purgeCache) await runtime.cache.purge();
      io.stdout(
        command.purgeCache
          ? "Sessão e cache local removidos."
          : "Sessão removida; o cache íntegro foi preservado.",
      );
      return EXIT_CODES.success;
    case "interactive":
    case "help":
    case "version":
      throw new CliError(
        `O comando ${command.kind} deve ser tratado pela entrada do CLI.`,
        EXIT_CODES.usageOrConfiguration,
      );
  }
}
