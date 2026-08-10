import { spawnSync } from "node:child_process";

import { parseSemver } from "../src/semver";

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
}

interface WorkflowRun {
  databaseId: number;
  headSha: string;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

const repositoryRoot = process.cwd();
const allowedArguments = new Set(["--dry-run"]);

function run(
  command: string,
  args: string[],
  options: { inherit?: boolean; allowFailure?: boolean } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  const status = result.status ?? 1;
  const stdout = (result.stdout as string | null) ?? "";
  const stderr = (result.stderr as string | null) ?? "";
  if (status !== 0 && !options.allowFailure) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      detail
        ? `${command} ${args.join(" ")} falhou: ${detail}`
        : `${command} ${args.join(" ")} falhou.`,
    );
  }
  return { status, stdout, stderr };
}

function capture(command: string, args: string[]): string {
  return run(command, args).stdout.trim();
}

function assertCleanWorktree(): void {
  if (capture("git", ["status", "--porcelain"]) !== "") {
    throw new Error(
      "A árvore de trabalho contém alterações. Faça commit ou descarte-as antes do release.",
    );
  }
}

export function resolveReleaseIdentity(metadata: PackageMetadata): {
  packageName: string;
  version: string;
  tag: string;
} {
  if (typeof metadata.name !== "string" || metadata.name.length === 0) {
    throw new Error("O package.json não contém um nome de pacote válido.");
  }
  if (typeof metadata.version !== "string") {
    throw new Error("O package.json não contém uma versão válida.");
  }
  parseSemver(metadata.version);
  return {
    packageName: metadata.name,
    version: metadata.version,
    tag: `v${metadata.version}`,
  };
}

async function registryHasVersion(
  packageName: string,
  version: string,
): Promise<boolean> {
  const packagePath = encodeURIComponent(packageName);
  const response = await fetch(
    `https://registry.npmjs.org/${packagePath}/${version}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(
    `O npm respondeu HTTP ${String(response.status)}; não é seguro continuar o release.`,
  );
}

function assertMainCanBePublished(headSha: string): boolean {
  const branch = capture("git", ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new Error(`O release deve partir de main; branch atual: ${branch}.`);
  }

  const remoteSha = capture("git", ["rev-parse", "origin/main"]);
  if (remoteSha === headSha) return false;

  const remoteIsAncestor = run(
    "git",
    ["merge-base", "--is-ancestor", "origin/main", headSha],
    { allowFailure: true },
  );
  if (remoteIsAncestor.status === 0) return true;

  throw new Error(
    "A main local está atrasada ou divergiu de origin/main. Execute git pull --ff-only antes do release.",
  );
}

function resolveExistingTag(tag: string, headSha: string): boolean {
  const result = run("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
    allowFailure: true,
  });
  if (result.status !== 0) return false;

  const taggedSha = capture("git", ["rev-list", "-n", "1", tag]);
  if (taggedSha !== headSha) {
    throw new Error(
      `A tag ${tag} já existe em outro commit. A versão não pode ser reutilizada.`,
    );
  }
  return true;
}

function remoteHasTag(tag: string): boolean {
  return (
    run(
      "git",
      ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
      { allowFailure: true },
    ).status === 0
  );
}

export function selectWorkflowRun(
  runs: WorkflowRun[],
  headSha: string,
): WorkflowRun | undefined {
  return runs.find((workflowRun) => workflowRun.headSha === headSha);
}

function findWorkflowRun(headSha: string): WorkflowRun | undefined {
  const output = capture("gh", [
    "run",
    "list",
    "--workflow",
    "publish.yml",
    "--event",
    "push",
    "--limit",
    "20",
    "--json",
    "databaseId,headSha",
  ]);
  const runs = JSON.parse(output) as WorkflowRun[];
  return selectWorkflowRun(runs, headSha);
}

async function waitForWorkflowRun(headSha: string): Promise<WorkflowRun> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const workflowRun = findWorkflowRun(headSha);
    if (workflowRun) return workflowRun;
    await Bun.sleep(2_000);
  }
  throw new Error(
    "O workflow publish.yml não apareceu em até 60 segundos. Consulte gh run list --workflow publish.yml.",
  );
}

async function waitForRegistry(
  packageName: string,
  version: string,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await registryHasVersion(packageName, version)) return;
    await Bun.sleep(3_000);
  }
  throw new Error(
    `O workflow terminou, mas ${packageName}@${version} não apareceu no npm em até 90 segundos.`,
  );
}

export async function release(args = process.argv.slice(2)): Promise<void> {
  const unknownArgument = args.find(
    (argument) => !allowedArguments.has(argument),
  );
  if (unknownArgument) {
    throw new Error(
      `Opção desconhecida: ${unknownArgument}. Use somente --dry-run.`,
    );
  }
  const dryRun = args.includes("--dry-run");
  const metadata = (await Bun.file(
    `${repositoryRoot}/package.json`,
  ).json()) as PackageMetadata;
  const { packageName, version, tag } = resolveReleaseIdentity(metadata);

  console.info(`Preparando ${packageName}@${version} (${tag}).`);
  assertCleanWorktree();
  run("git", ["fetch", "origin", "main", "--tags", "--prune"], {
    inherit: true,
  });

  const headSha = capture("git", ["rev-parse", "HEAD"]);
  const mainNeedsPush = assertMainCanBePublished(headSha);
  const tagExistsLocally = resolveExistingTag(tag, headSha);
  const tagExistsRemotely = remoteHasTag(tag);

  if (await registryHasVersion(packageName, version)) {
    console.info(`${packageName}@${version} já está publicado no npm.`);
    return;
  }

  console.info("Executando instalação congelada e gate completo...");
  run("bun", ["ci"], { inherit: true });
  run("bun", ["run", "check"], { inherit: true });
  assertCleanWorktree();

  if (dryRun) {
    console.info(
      `Dry run concluído. ${tagExistsRemotely ? `A tag ${tag} já está no origin e o workflow será retomado` : `A tag ${tag} será criada e enviada`}.`,
    );
    return;
  }

  if (mainNeedsPush) {
    console.info("Enviando a main validada...");
    run("git", ["push", "origin", "main"], { inherit: true });
  }

  if (!tagExistsLocally) {
    run("git", ["tag", "-a", tag, "-m", `Release ${packageName} ${tag}`], {
      inherit: true,
    });
  }
  if (!tagExistsRemotely) {
    console.info(`Enviando ${tag} para iniciar o publish.yml...`);
    run("git", ["push", "origin", tag], { inherit: true });
  } else {
    console.info(`${tag} já está no origin; retomando o workflow existente.`);
  }

  const workflowRun = await waitForWorkflowRun(headSha);
  run("gh", ["run", "watch", String(workflowRun.databaseId), "--exit-status"], {
    inherit: true,
  });
  await waitForRegistry(packageName, version);
  console.info(`${packageName}@${version} publicado com sucesso.`);
}

if (import.meta.main) {
  try {
    await release();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Falha inesperada.";
    console.error(`Release interrompido: ${message}`);
    process.exitCode = 1;
  }
}
