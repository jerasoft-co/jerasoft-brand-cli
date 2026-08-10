import { readdir } from "node:fs/promises";
import path from "node:path";

import packageMetadata from "../package.json" with { type: "json" };

import {
  DEFAULT_ASSET_DIRECTORY,
  DEFAULT_TOKEN_DIRECTORY,
  EXIT_CODES,
} from "./constants";
import { CliError } from "./errors";
import type { ResolvedManifest } from "./cache";
import {
  readableProjectConfigSchema,
  projectConfigSchema,
  projectLockSchema,
  type AgentArtifact,
  type ManifestPayload,
  type ProjectConfig,
  type ProjectLock,
  type TokenAdapter,
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
const managedSkillMarker = "<!-- jerasoft-brand:managed-skill -->";

export type AgentsFileState =
  "absent" | "existing" | "managed" | "invalid-managed-block";

export type AgentSkillsState = "absent" | "partial" | "managed" | "conflict";

export interface AgentSkillsInspection {
  state: AgentSkillsState;
  installed: number;
  total: number;
}

export interface ProjectInspection {
  existingProject: boolean;
  brandInitialized: boolean;
  brandLockPresent: boolean;
  agentsFile: AgentsFileState;
  agentSkills: AgentSkillsInspection;
  signals: string[];
}

const genericBootstrap = `${managedStart}
## Contrato de marca JeraSoft

Antes de criar, alterar ou auditar interfaces e materiais JeraSoft, execute o
perfil correspondente e trate a saída como contrato vigente:

\`\`\`sh
npx @jerasoft/brand@1 context --profile=apply --format=markdown
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

${managedSkillMarker}

# Aplicar marca JeraSoft

Antes de agir, execute:

\`\`\`sh
npx @jerasoft/brand@1 context --profile=apply --format=markdown
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

${managedSkillMarker}

# Auditar interface JeraSoft

Antes da auditoria, execute:

\`\`\`sh
npx @jerasoft/brand@1 context --profile=audit --format=markdown
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

${managedSkillMarker}

# Resolver ativos JeraSoft

Antes de escolher mídia, execute:

\`\`\`sh
npx @jerasoft/brand@1 context --profile=assets --format=markdown
\`\`\`

Depois materialize somente IDs retornados pelo contexto com
\`asset resolve <id> --copy-to=<destino>\`.
`,
  },
];

export const DEFAULT_AGENT_ARTIFACTS: AgentArtifact[] = [
  "instructions",
  "skills",
];

const tokenPayloadByAdapter: Record<TokenAdapter | "dtcg", string> = {
  dtcg: "contract.jerasoft-tokens",
  css: "contract.jerasoft-tokens-css",
  "delphi-vcl": "contract.jerasoft-tokens-vcl",
  "delphi-fmx": "contract.jerasoft-tokens-fmx",
};

export function configuredTokenPayloadIds(config: ProjectConfig) {
  if (!config.tokens.enabled) return [];
  return [
    tokenPayloadByAdapter.dtcg,
    ...config.tokens.adapters.map((adapter) => tokenPayloadByAdapter[adapter]),
  ];
}

function skillPath(projectRoot: string, skill: BootstrapSkill) {
  return path.join(
    projectRoot,
    ".agents",
    "skills",
    skill.directory,
    "SKILL.md",
  );
}

function unmarkedSkillContents(skill: BootstrapSkill) {
  return skill.contents.replace(`${managedSkillMarker}\n\n`, "");
}

function isManagedSkill(contents: string, skill: BootstrapSkill) {
  if (contents.includes(managedSkillMarker)) return true;
  const unmarked = unmarkedSkillContents(skill);
  const bunLegacy = unmarked.replaceAll(
    "npx @jerasoft/brand@1",
    "bunx --bun @jerasoft/brand@1",
  );
  return contents === unmarked || contents === bunLegacy;
}

async function readAgentSkill(projectRoot: string, skill: BootstrapSkill) {
  const target = skillPath(projectRoot, skill);
  await assertSafeParentChain(projectRoot, target);
  return readRegularFile(target);
}

async function inspectAgentSkills(
  projectRoot: string,
): Promise<AgentSkillsInspection> {
  let installed = 0;
  let conflicts = 0;
  for (const skill of bootstrapSkills) {
    const current = await readAgentSkill(projectRoot, skill);
    if (!current) continue;
    if (isManagedSkill(current.toString("utf8"), skill)) installed += 1;
    else conflicts += 1;
  }
  const state: AgentSkillsState =
    conflicts > 0
      ? "conflict"
      : installed === 0
        ? "absent"
        : installed === bootstrapSkills.length
          ? "managed"
          : "partial";
  return { state, installed, total: bootstrapSkills.length };
}

async function assertWritableAgentSkills(projectRoot: string) {
  for (const skill of bootstrapSkills) {
    const current = await readAgentSkill(projectRoot, skill);
    if (current && !isManagedSkill(current.toString("utf8"), skill)) {
      throw new CliError(
        `A Agent Skill ${skill.directory} já existe e não é gerenciada pela JeraSoft. Preserve ou renomeie o arquivo antes de inicializar.`,
        EXIT_CODES.integrity,
      );
    }
  }
}

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

async function inspectAgentsFile(
  projectRoot: string,
): Promise<AgentsFileState> {
  const current = await readRegularFile(path.join(projectRoot, "AGENTS.md"));
  if (!current) return "absent";
  return agentsStateFromText(current.toString("utf8"));
}

function agentsStateFromText(text: string): AgentsFileState {
  const starts = text.split(managedStart).length - 1;
  const ends = text.split(managedEnd).length - 1;
  if (
    starts !== ends ||
    starts > 1 ||
    (starts === 1 && text.indexOf(managedEnd) < text.indexOf(managedStart))
  ) {
    return "invalid-managed-block";
  }
  return starts === 1 ? "managed" : "existing";
}

export async function inspectProject(
  projectRoot: string,
): Promise<ProjectInspection> {
  const entries = await readdir(projectRoot);
  const meaningfulEntries = entries.filter(
    (entry) => !new Set([".DS_Store", "Thumbs.db"]).has(entry),
  );
  const signalCandidates = [
    {
      paths: ["next.config.js", "next.config.mjs", "next.config.ts"],
      label: "Next.js",
    },
    {
      paths: ["vite.config.js", "vite.config.mjs", "vite.config.ts"],
      label: "Vite",
    },
    { paths: ["package.json"], label: "package.json" },
    { paths: ["bun.lock", "bun.lockb"], label: "Bun" },
    { paths: ["pnpm-lock.yaml"], label: "pnpm" },
    { paths: ["package-lock.json"], label: "npm" },
    { paths: ["yarn.lock"], label: "Yarn" },
    { paths: ["deno.json", "deno.jsonc"], label: "Deno" },
    { paths: ["pyproject.toml", "requirements.txt"], label: "Python" },
    { paths: ["Cargo.toml"], label: "Rust" },
    { paths: ["go.mod"], label: "Go" },
    { paths: [".git"], label: "Git" },
    { paths: ["AGENTS.md"], label: "AGENTS.md" },
  ] as const;
  const detected = await Promise.all(
    signalCandidates.map(async (candidate) => ({
      label: candidate.label,
      present: (
        await Promise.all(
          candidate.paths.map((entry) =>
            pathExists(path.join(projectRoot, entry)),
          ),
        )
      ).some(Boolean),
    })),
  );
  const signals: string[] = detected
    .filter((candidate) => candidate.present)
    .map((candidate) => candidate.label);
  const delphiProjects = meaningfulEntries.filter((entry) =>
    entry.toLowerCase().endsWith(".dproj"),
  );
  if (delphiProjects.length > 0) {
    const projectFiles = await Promise.all(
      delphiProjects.map((entry) =>
        readRegularFile(path.join(projectRoot, entry)),
      ),
    );
    const usesFmx = projectFiles.some((contents) =>
      contents?.toString("utf8").includes("<FrameworkType>FMX</FrameworkType>"),
    );
    signals.push(usesFmx ? "Delphi FMX" : "Delphi VCL");
  }
  const [brandInitialized, brandLockPresent, agentsFile, agentSkills] =
    await Promise.all([
      pathExists(projectPaths(projectRoot).config),
      pathExists(projectPaths(projectRoot).lock),
      inspectAgentsFile(projectRoot),
      inspectAgentSkills(projectRoot),
    ]);

  return {
    existingProject: meaningfulEntries.length > 0,
    brandInitialized,
    brandLockPresent,
    agentsFile,
    agentSkills,
    signals:
      signals.length > 0
        ? signals
        : meaningfulEntries.length > 0
          ? ["arquivos existentes"]
          : [],
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
    const config = readableProjectConfigSchema.parse(raw);
    if (config.schemaVersion === 3) return config;
    if (config.schemaVersion === 2) {
      return projectConfigSchema.parse({
        ...config,
        schemaVersion: 3,
        cliRange: `^${packageMetadata.version}`,
        appearance: { default: "light", experiences: {} },
        tokens: {
          enabled: true,
          outputDirectory: DEFAULT_TOKEN_DIRECTORY,
          adapters: [],
        },
      });
    }
    const agentArtifacts: AgentArtifact[] = [];
    if (config.agentAdapters.includes("generic")) {
      agentArtifacts.push("instructions");
    }
    if (config.agentAdapters.includes("codex")) {
      agentArtifacts.push("skills");
    }
    return projectConfigSchema.parse({
      schemaVersion: 3,
      protocol: config.protocol,
      channel: config.channel,
      cliRange: `^${packageMetadata.version}`,
      contractRange: config.contractRange,
      updatePolicy: config.updatePolicy,
      agentArtifacts,
      assetDirectory: config.assetDirectory,
      appearance: { default: "light", experiences: {} },
      tokens: {
        enabled: true,
        outputDirectory: DEFAULT_TOKEN_DIRECTORY,
        adapters: [],
      },
    });
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
  agentArtifacts: AgentArtifact[] = DEFAULT_AGENT_ARTIFACTS,
): ProjectConfig {
  return projectConfigSchema.parse({
    schemaVersion: 3,
    protocol: 1,
    channel: "stable",
    cliRange: `^${packageMetadata.version}`,
    contractRange: "^1.1.0",
    updatePolicy: "compatible",
    agentArtifacts,
    assetDirectory: DEFAULT_ASSET_DIRECTORY,
    appearance: { default: "light", experiences: {} },
    tokens: {
      enabled: true,
      outputDirectory: DEFAULT_TOKEN_DIRECTORY,
      adapters: [],
    },
  });
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
  if (agentsStateFromText(text) === "invalid-managed-block") {
    throw new CliError(
      "O bloco gerenciado da marca em AGENTS.md está incompleto ou duplicado.",
      EXIT_CODES.integrity,
    );
  }
  const start = text.indexOf(managedStart);
  const end = text.indexOf(managedEnd);
  const next =
    start >= 0
      ? `${text.slice(0, start)}${genericBootstrap}${text.slice(end + managedEnd.length)}`
      : `${text}${text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"}${genericBootstrap}\n`;
  await atomicWriteFile(agentsPath, next, 0o644);
}

async function writeAgentSkills(projectRoot: string) {
  for (const skill of bootstrapSkills) {
    await atomicWriteFile(skillPath(projectRoot, skill), skill.contents, 0o644);
  }
}

export async function initializeProject(
  projectRoot: string,
  config: ProjectConfig,
  lock: ProjectLock,
) {
  if (config.agentArtifacts.includes("instructions")) {
    const agentsFile = await inspectAgentsFile(projectRoot);
    if (agentsFile === "invalid-managed-block") {
      throw new CliError(
        "O bloco gerenciado da marca em AGENTS.md está incompleto ou duplicado.",
        EXIT_CODES.integrity,
      );
    }
  }
  if (config.agentArtifacts.includes("skills")) {
    await assertWritableAgentSkills(projectRoot);
  }
  await atomicWriteFile(
    projectPaths(projectRoot).config,
    serialize(projectConfigSchema.parse(config)),
    0o644,
  );
  await writeProjectLock(projectRoot, lock);
  if (config.agentArtifacts.includes("instructions")) {
    await writeManagedAgents(projectRoot);
  }
  if (config.agentArtifacts.includes("skills")) {
    await writeAgentSkills(projectRoot);
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

export async function materializeTokenPayload(
  projectRoot: string,
  config: ProjectConfig,
  payload: ManifestPayload,
  contents: Uint8Array,
  previousPayload?: ManifestPayload,
) {
  if (!payload.recommendedFilename) {
    throw new CliError(
      `O payload ${payload.id} não declara nome de arquivo recomendado.`,
      EXIT_CODES.integrity,
    );
  }
  const tokenRoot = resolveInside(projectRoot, config.tokens.outputDirectory);
  const destination = resolveInside(tokenRoot, payload.recommendedFilename);
  await assertSafeParentChain(projectRoot, destination);
  const existing = await readRegularFile(destination);
  if (existing) {
    const existingDigest = sha256(existing);
    if (existingDigest === payload.sha256) {
      return { destination, changed: false };
    }
    if (previousPayload?.sha256 !== existingDigest) {
      throw new CliError(
        `O arquivo gerenciado divergiu manualmente: ${path.relative(projectRoot, destination)}.`,
        EXIT_CODES.drift,
      );
    }
  }
  await atomicWriteFile(destination, contents, 0o644);
  return { destination, changed: true };
}

export async function auditTokenPayload(
  projectRoot: string,
  config: ProjectConfig,
  payload: ManifestPayload,
) {
  if (!payload.recommendedFilename) return false;
  const tokenRoot = resolveInside(projectRoot, config.tokens.outputDirectory);
  const destination = resolveInside(tokenRoot, payload.recommendedFilename);
  await assertSafeParentChain(projectRoot, destination);
  const existing = await readRegularFile(destination);
  if (!existing || sha256(existing) !== payload.sha256) return false;
  const text = existing.toString("utf8");
  if (payload.id === tokenPayloadByAdapter.dtcg) {
    try {
      const document = JSON.parse(text) as Record<string, unknown>;
      const extensions = document.$extensions as
        Record<string, Record<string, unknown>> | undefined;
      const contract = extensions?.["com.jerasoft.contract"];
      const color = document.color as Record<string, unknown> | undefined;
      return Boolean(
        contract?.dtcgFormat === "2025.10" &&
        Array.isArray(contract.contrastPairs) &&
        contract.contrastPairs.length > 0 &&
        color?.palette &&
        color.light &&
        color.dark,
      );
    } catch {
      return false;
    }
  }
  if (payload.id === tokenPayloadByAdapter.css) {
    return (
      text.includes('data-jera-appearance="light"') &&
      text.includes('data-jera-appearance="dark"') &&
      text.includes("@supports (color: oklch(0 0 0))")
    );
  }
  if (payload.id === tokenPayloadByAdapter["delphi-vcl"]) {
    return (
      text.includes("TJeraVclColor") &&
      text.includes("Alpha: Byte") &&
      text.includes("OpaqueFallback: TColor")
    );
  }
  if (payload.id === tokenPayloadByAdapter["delphi-fmx"]) {
    return text.includes("TAlphaColor") && text.includes("$FF");
  }
  return true;
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
