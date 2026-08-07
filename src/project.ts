import path from "node:path";

import packageMetadata from "../package.json" with { type: "json" };

import { DEFAULT_ASSET_DIRECTORY, EXIT_CODES } from "./constants";
import { CliError } from "./errors";
import type { ResolvedManifest } from "./cache";
import {
  projectConfigSchema,
  projectLockSchema,
  type ManifestPayload,
  type ProjectConfig,
  type ProjectLock,
} from "./schemas";
import {
  assertSafeParentChain,
  atomicWriteFile,
  pathExists,
  readRegularFile,
  resolveInside,
  sha256,
} from "./security";
import { parseSemver } from "./semver";

const managedStart = "<!-- jerasoft-brand:start -->";
const managedEnd = "<!-- jerasoft-brand:end -->";

const genericBootstrap = `${managedStart}
## Contrato de marca JeraSoft

Antes de criar, alterar ou auditar interfaces e materiais JeraSoft, execute o
perfil correspondente e trate a saída como contrato vigente:

\`\`\`sh
bunx --bun @jerasoft/brand@1 context --profile=apply --format=markdown
\`\`\`

Use \`--profile=audit\` para auditoria e \`--profile=assets\` para localizar
mídia oficial. Materialize ativos somente com
\`asset resolve <id> --copy-to=<destino>\`. Nunca substitua esse fluxo por
busca pública ou por uma cópia não verificada.
${managedEnd}`;

interface BootstrapSkill {
  directory: string;
  contents: string;
}

const bootstrapSkills: BootstrapSkill[] = [
  {
    directory: "jerasoft-apply-brand",
    contents: `---
name: jerasoft-apply-brand
description: Resolve e aplica o contrato vigente da marca JeraSoft às ferramentas já disponíveis no projeto.
---

# Aplicar marca JeraSoft

Antes de agir, execute:

\`\`\`sh
bunx --bun @jerasoft/brand@1 context --profile=apply --format=markdown
\`\`\`

Leia integralmente a saída, siga o contrato resolvido e use somente ativos
materializados pelo CLI oficial.
`,
  },
  {
    directory: "jerasoft-audit-interface",
    contents: `---
name: jerasoft-audit-interface
description: Resolve o contrato vigente e orienta auditorias verificáveis de interfaces e materiais JeraSoft.
---

# Auditar interface JeraSoft

Antes da auditoria, execute:

\`\`\`sh
bunx --bun @jerasoft/brand@1 context --profile=audit --format=markdown
\`\`\`

Leia integralmente a saída e mantenha a auditoria sem alterações, salvo quando
a solicitação também autorizar implementação.
`,
  },
  {
    directory: "jerasoft-resolve-assets",
    contents: `---
name: jerasoft-resolve-assets
description: Resolve logos e outros ativos oficiais JeraSoft por identificador e digest verificável.
---

# Resolver ativos JeraSoft

Antes de escolher mídia, execute:

\`\`\`sh
bunx --bun @jerasoft/brand@1 context --profile=assets --format=markdown
\`\`\`

Depois materialize somente IDs retornados pelo contexto com
\`asset resolve <id> --copy-to=<destino>\`.
`,
  },
];

function serialize(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function projectPaths(projectRoot: string) {
  const metadataDirectory = path.join(projectRoot, ".jerasoft");
  return {
    config: path.join(metadataDirectory, "brand.json"),
    lock: path.join(metadataDirectory, "brand.lock.json"),
  };
}

async function readJson(filePath: string) {
  const contents = await readRegularFile(filePath);
  if (!contents) return null;
  try {
    return JSON.parse(contents.toString()) as unknown;
  } catch (error) {
    throw new CliError(
      `O arquivo ${path.basename(filePath)} contém JSON inválido.`,
      EXIT_CODES.usageOrConfiguration,
      { cause: error },
    );
  }
}

export async function loadProjectConfig(projectRoot: string) {
  const raw = await readJson(projectPaths(projectRoot).config);
  if (!raw) {
    throw new CliError(
      "Este projeto ainda não foi inicializado. Execute jerasoft-brand init.",
      EXIT_CODES.usageOrConfiguration,
    );
  }
  try {
    return projectConfigSchema.parse(raw);
  } catch (error) {
    throw new CliError(
      "A configuração .jerasoft/brand.json é inválida.",
      EXIT_CODES.usageOrConfiguration,
      { cause: error },
    );
  }
}

export async function loadProjectLock(projectRoot: string) {
  const raw = await readJson(projectPaths(projectRoot).lock);
  if (!raw) {
    throw new CliError(
      "O lock da marca não existe. Execute jerasoft-brand sync.",
      EXIT_CODES.drift,
    );
  }
  try {
    return projectLockSchema.parse(raw);
  } catch (error) {
    throw new CliError(
      "O arquivo .jerasoft/brand.lock.json é inválido.",
      EXIT_CODES.integrity,
      { cause: error },
    );
  }
}

export function createDefaultConfig(
  adapters: ProjectConfig["agentAdapters"],
): ProjectConfig {
  return projectConfigSchema.parse({
    schemaVersion: 1,
    protocol: 1,
    channel: "stable",
    cliRange: `^${packageMetadata.version}`,
    contractRange: "^1.0.0",
    updatePolicy: "compatible",
    agentAdapters: adapters,
    assetDirectory: DEFAULT_ASSET_DIRECTORY,
  });
}

export async function detectAdapters(
  projectRoot: string,
  adapter: "auto" | "generic" | "codex",
): Promise<ProjectConfig["agentAdapters"]> {
  if (adapter === "generic") return ["generic"];
  if (adapter === "codex") return ["generic", "codex"];
  const codexSignals = [".agents", ".codex"];
  const codex = (
    await Promise.all(
      codexSignals.map((entry) => pathExists(path.join(projectRoot, entry))),
    )
  ).some(Boolean);
  return codex ? ["generic", "codex"] : ["generic"];
}

export function assertCompatible(
  config: ProjectConfig,
  resolved: ResolvedManifest,
) {
  const contractMajor = parseSemver(resolved.manifest.versions.contract).major;
  const configuredMajor = parseSemver(config.contractRange.slice(1)).major;
  if (contractMajor !== configuredMajor) {
    throw new CliError(
      `O contrato ${resolved.manifest.versions.contract} exige migração explícita. Execute upgrade --major.`,
      EXIT_CODES.incompatibleMajor,
    );
  }
}

export function lockFromResolved(
  resolved: ResolvedManifest,
  now = new Date(),
): ProjectLock {
  return projectLockSchema.parse({
    schemaVersion: 1,
    protocol: 1,
    channel: "stable",
    releaseTag: resolved.manifest.releaseTag,
    sourceCommit: resolved.manifest.sourceCommit,
    resolvedAt: now.toISOString(),
    versions: resolved.manifest.versions,
    manifestSha256: resolved.manifestSha256,
    payloads: resolved.manifest.payloads,
  });
}

async function writeManagedAgents(projectRoot: string) {
  const agentsPath = path.join(projectRoot, "AGENTS.md");
  const current = await readRegularFile(agentsPath);
  if (!current) {
    await atomicWriteFile(agentsPath, `${genericBootstrap}\n`, 0o644);
    return;
  }
  const text = current.toString("utf8");
  const start = text.indexOf(managedStart);
  const end = text.indexOf(managedEnd);
  if (start >= 0 !== end >= 0 || (start >= 0 && end < start)) {
    throw new CliError(
      "O bloco gerenciado da marca em AGENTS.md está incompleto.",
      EXIT_CODES.integrity,
    );
  }
  const next =
    start >= 0
      ? `${text.slice(0, start)}${genericBootstrap}${text.slice(end + managedEnd.length)}`
      : `${text.trimEnd()}\n\n${genericBootstrap}\n`;
  await atomicWriteFile(agentsPath, next, 0o644);
}

async function writeCodexSkills(projectRoot: string) {
  for (const skill of bootstrapSkills) {
    await atomicWriteFile(
      path.join(projectRoot, ".agents", "skills", skill.directory, "SKILL.md"),
      skill.contents,
      0o644,
    );
  }
}

export async function initializeProject(
  projectRoot: string,
  config: ProjectConfig,
  lock: ProjectLock,
) {
  await atomicWriteFile(
    projectPaths(projectRoot).config,
    serialize(projectConfigSchema.parse(config)),
    0o644,
  );
  await writeProjectLock(projectRoot, lock);
  if (config.agentAdapters.includes("generic")) {
    await writeManagedAgents(projectRoot);
  }
  if (config.agentAdapters.includes("codex")) {
    await writeCodexSkills(projectRoot);
  }
}

export async function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
) {
  await atomicWriteFile(
    projectPaths(projectRoot).config,
    serialize(projectConfigSchema.parse(config)),
    0o644,
  );
}

export async function writeProjectLock(projectRoot: string, lock: ProjectLock) {
  await atomicWriteFile(
    projectPaths(projectRoot).lock,
    serialize(projectLockSchema.parse(lock)),
    0o644,
  );
}

export async function materializeAsset(
  projectRoot: string,
  config: ProjectConfig,
  requestedDestination: string,
  payload: ManifestPayload,
  contents: Uint8Array,
) {
  const assetRoot = resolveInside(projectRoot, config.assetDirectory);
  const destination = resolveInside(projectRoot, requestedDestination);
  const relation = path.relative(assetRoot, destination);
  if (
    relation.startsWith("..") ||
    path.isAbsolute(relation) ||
    relation === ""
  ) {
    throw new CliError(
      `O destino precisa ficar dentro de ${config.assetDirectory}.`,
      EXIT_CODES.usageOrConfiguration,
    );
  }
  await assertSafeParentChain(projectRoot, destination);
  const existing = await readRegularFile(destination);
  if (existing) {
    if (sha256(existing) === payload.sha256) {
      return { destination, changed: false };
    }
    throw new CliError(
      `O destino já existe com conteúdo diferente: ${requestedDestination}.`,
      EXIT_CODES.drift,
    );
  }
  await atomicWriteFile(destination, contents, 0o644);
  return { destination, changed: true };
}

export function lockMatchesManifest(
  lock: ProjectLock,
  resolved: ResolvedManifest,
) {
  return (
    lock.releaseTag === resolved.manifest.releaseTag &&
    lock.sourceCommit === resolved.manifest.sourceCommit &&
    lock.manifestSha256 === resolved.manifestSha256 &&
    JSON.stringify(lock.versions) ===
      JSON.stringify(resolved.manifest.versions) &&
    JSON.stringify(lock.payloads) === JSON.stringify(resolved.manifest.payloads)
  );
}
