import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  select,
} from "@clack/prompts";

import { atomicWriteFile } from "../src/security";
import { parseSemver } from "../src/semver";

export type VersionBumpKind = "build" | "minor" | "major";

interface PackageMetadata {
  version?: unknown;
  [key: string]: unknown;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface VersionBumpOption {
  value: VersionBumpKind | "exit";
  label: string;
  hint?: string;
}

export interface VersionBumpPrompter {
  intro(message: string): void;
  select(
    message: string,
    options: VersionBumpOption[],
    initialValue: VersionBumpKind,
  ): Promise<VersionBumpKind | "exit" | null>;
  confirm(message: string, initialValue: boolean): Promise<boolean | null>;
  outro(message: string): void;
  cancel(message: string): void;
}

interface VersionBumpOptions {
  repositoryRoot?: string;
  runCommand?: (command: string, args: string[], cwd: string) => CommandResult;
  stdout?: (message: string) => void;
  prompter?: VersionBumpPrompter;
  interactive?: boolean;
}

export const VERSION_BUMP_USAGE = `Uso:
  bun run version:bump
  bun run version:bump -- <build|minor|major> [--dry-run]

Incrementos:
  build  Incrementa o patch SemVer (1.2.0 → 1.2.1)
  minor  Incrementa a versão compatível (1.2.0 → 1.3.0)
  major  Incrementa a versão com mudanças incompatíveis (1.2.0 → 2.0.0)

Sem argumentos, abre o menu navegável.`;

const defaultRepositoryRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

const defaultPrompter: VersionBumpPrompter = {
  intro,
  async select(message, options, initialValue) {
    const result = await select<VersionBumpKind | "exit">({
      message,
      options,
      initialValue,
      maxItems: options.length,
      showInstructions: false,
    });
    return isCancel(result) ? null : result;
  },
  async confirm(message, initialValue) {
    const result = await confirm({
      message,
      initialValue,
      active: "Sim",
      inactive: "Não",
    });
    return isCancel(result) ? null : result;
  },
  outro,
  cancel,
};

function defaultRunCommand(
  command: string,
  args: string[],
  cwd: string,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function parseVersionBumpArguments(args: string[]): {
  kind: VersionBumpKind | null;
  dryRun: boolean;
  help: boolean;
} {
  const unknownOption = args.find(
    (argument) =>
      argument.startsWith("-") &&
      !new Set(["--dry-run", "--help", "-h"]).has(argument),
  );
  if (unknownOption) {
    throw new Error(`Opção desconhecida: ${unknownOption}.`);
  }
  if (args.filter((argument) => argument === "--dry-run").length > 1) {
    throw new Error("Informe --dry-run apenas uma vez.");
  }
  const help = args.includes("--help") || args.includes("-h");
  if (help) {
    if (args.length !== 1) {
      throw new Error("Use --help sem outros argumentos.");
    }
    return { kind: null, dryRun: false, help: true };
  }
  const kinds = args.filter((argument) => !argument.startsWith("-"));
  if (
    kinds.length > 1 ||
    (kinds.length === 1 &&
      !new Set<VersionBumpKind>(["build", "minor", "major"]).has(
        kinds[0] as VersionBumpKind,
      ))
  ) {
    throw new Error(VERSION_BUMP_USAGE);
  }
  return {
    kind: (kinds[0] as VersionBumpKind | undefined) ?? null,
    dryRun: args.includes("--dry-run"),
    help: false,
  };
}

function incrementSafely(value: number, component: string) {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `O componente ${component} da versão não pode ser incrementado.`,
    );
  }
  return value + 1;
}

export function nextVersion(
  currentVersion: string,
  kind: VersionBumpKind,
): string {
  const current = parseSemver(currentVersion);
  if (
    !Number.isSafeInteger(current.major) ||
    !Number.isSafeInteger(current.minor) ||
    !Number.isSafeInteger(current.patch)
  ) {
    throw new Error("A versão atual excede os limites inteiros seguros.");
  }
  switch (kind) {
    case "build":
      return `${String(current.major)}.${String(current.minor)}.${String(incrementSafely(current.patch, "patch"))}`;
    case "minor":
      return `${String(current.major)}.${String(incrementSafely(current.minor, "minor"))}.0`;
    case "major":
      return `${String(incrementSafely(current.major, "major"))}.0.0`;
  }
}

function parsePackageMetadata(contents: string): PackageMetadata {
  let metadata: unknown;
  try {
    metadata = JSON.parse(contents);
  } catch (error) {
    throw new Error("O package.json contém JSON inválido.", { cause: error });
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("O package.json não contém um objeto válido.");
  }
  const packageMetadata = metadata as PackageMetadata;
  if (typeof packageMetadata.version !== "string") {
    throw new Error("O package.json não contém uma versão válida.");
  }
  parseSemver(packageMetadata.version);
  return packageMetadata;
}

function commandFailure(
  command: string,
  args: string[],
  result: CommandResult,
) {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(
    detail
      ? `${command} ${args.join(" ")} falhou: ${detail}`
      : `${command} ${args.join(" ")} falhou.`,
  );
}

function versionOptions(currentVersion: string): VersionBumpOption[] {
  return [
    {
      value: "build",
      label: "Build de correção",
      hint: `${nextVersion(currentVersion, "build")} · patch SemVer`,
    },
    {
      value: "minor",
      label: "Versão minor",
      hint: `${nextVersion(currentVersion, "minor")} · novas mudanças compatíveis`,
    },
    {
      value: "major",
      label: "Versão major",
      hint: `${nextVersion(currentVersion, "major")} · mudanças incompatíveis`,
    },
    { value: "exit", label: "Sair sem alterar" },
  ];
}

export async function bumpVersion(
  args = process.argv.slice(2),
  options: VersionBumpOptions = {},
) {
  const parsed = parseVersionBumpArguments(args);
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const stdout = options.stdout ?? console.info;
  const prompter = options.prompter ?? defaultPrompter;
  const interactive =
    options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);

  if (parsed.help) {
    stdout(VERSION_BUMP_USAGE);
    return { changed: false, help: true } as const;
  }

  const packagePath = path.join(repositoryRoot, "package.json");
  const lockPath = path.join(repositoryRoot, "bun.lock");
  const [originalPackage, originalLock] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(lockPath, "utf8"),
  ]);
  const metadata = parsePackageMetadata(originalPackage);
  const currentVersion = metadata.version as string;
  let kind = parsed.kind;
  const usingMenu = kind === null;
  if (kind === null) {
    if (!interactive) {
      throw new Error(
        "O menu de versão exige um terminal. Informe build, minor ou major como argumento.",
      );
    }
    prompter.intro(`Versionamento · versão atual ${currentVersion}`);
    const selected = await prompter.select(
      "Qual incremento você deseja aplicar?",
      versionOptions(currentVersion),
      "build",
    );
    if (!selected || selected === "exit") {
      prompter.cancel("Nenhuma alteração realizada.");
      return { currentVersion, changed: false, cancelled: true } as const;
    }
    kind = selected;
  }
  const version = nextVersion(currentVersion, kind);

  if (parsed.dryRun) {
    const message = `Pré-visualização: ${currentVersion} → ${version} (${kind}). Nenhum arquivo foi alterado.`;
    if (usingMenu) prompter.outro(message);
    else stdout(message);
    return { currentVersion, version, kind, changed: false } as const;
  }

  if (usingMenu) {
    const confirmed = await prompter.confirm(
      `Atualizar ${currentVersion} para ${version}?`,
      false,
    );
    if (!confirmed) {
      prompter.cancel("Nenhuma alteração realizada.");
      return {
        currentVersion,
        version,
        kind,
        changed: false,
        cancelled: true,
      } as const;
    }
  }

  const updatedPackage = `${JSON.stringify(
    { ...metadata, version },
    null,
    2,
  )}\n`;
  let packageWritten = false;
  try {
    await atomicWriteFile(packagePath, updatedPackage, 0o644);
    packageWritten = true;
    const installArgs = ["install", "--lockfile-only", "--ignore-scripts"];
    const result = runCommand("bun", installArgs, repositoryRoot);
    if (result.status !== 0) {
      throw commandFailure("bun", installArgs, result);
    }
    const verified = parsePackageMetadata(await readFile(packagePath, "utf8"));
    if (verified.version !== version) {
      throw new Error(
        "A versão gravada no package.json não pôde ser verificada.",
      );
    }
    const lock = await readFile(lockPath, "utf8");
    if (lock.length === 0) {
      throw new Error("O bun.lock ficou vazio após a sincronização.");
    }
  } catch (error) {
    if (packageWritten) {
      await Promise.all([
        atomicWriteFile(packagePath, originalPackage, 0o644),
        atomicWriteFile(lockPath, originalLock, 0o644),
      ]);
    }
    throw error;
  }

  if (usingMenu) {
    prompter.outro(
      `Versão atualizada: ${currentVersion} → ${version}. Execute bun run check.`,
    );
  } else {
    stdout(`Versão atualizada: ${currentVersion} → ${version} (${kind}).`);
    stdout("package.json atualizado e bun.lock sincronizado sem scripts.");
    stdout("Próximo passo: bun run check");
  }
  return { currentVersion, version, kind, changed: true } as const;
}

if (import.meta.main) {
  try {
    await bumpVersion();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Falha desconhecida.",
    );
    process.exitCode = 1;
  }
}
