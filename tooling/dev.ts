import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = await realpath(path.resolve(import.meta.dir, ".."));
const defaultProjectRoot = path.join(tmpdir(), "jerasoft-brand-dev");

function extractProjectRoot(arguments_: string[]) {
  let projectRoot = process.env.JERASOFT_BRAND_DEV_ROOT ?? defaultProjectRoot;
  const cliArguments: string[] = [];

  for (const argument of arguments_) {
    if (argument.startsWith("--dev-root=")) {
      projectRoot = argument.slice("--dev-root=".length);
      continue;
    }
    cliArguments.push(argument);
  }

  if (!projectRoot) {
    throw new Error("Informe um caminho não vazio em --dev-root.");
  }

  return { projectRoot: path.resolve(projectRoot), cliArguments };
}

function isInsideRepository(candidate: string) {
  const relative = path.relative(repositoryRoot, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

const { projectRoot, cliArguments } = extractProjectRoot(process.argv.slice(2));
await mkdir(projectRoot, { recursive: true });
const resolvedProjectRoot = await realpath(projectRoot);

if (isInsideRepository(resolvedProjectRoot)) {
  throw new Error(
    "O projeto de desenvolvimento precisa ficar fora do repositório público.",
  );
}

process.chdir(resolvedProjectRoot);
console.error(`[dev] Projeto isolado: ${resolvedProjectRoot}`);

const { runCli } = await import("../src/cli");
process.exitCode = await runCli(cliArguments);
