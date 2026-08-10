#!/usr/bin/env node

import packageMetadata from "../package.json" with { type: "json" };

import { parseArguments, type CliCommand } from "./arguments";
import { executeCommand } from "./commands";
import { EXIT_CODES } from "./constants";
import { CliError, safeErrorMessage } from "./errors";
import { runInteractiveMenu } from "./interactive";
import { defaultIo, type CliIo } from "./io";

const help = `JeraSoft Brand CLI ${packageMetadata.version}

Uso:
  jerasoft-brand
  jerasoft-brand init [--dry-run] [--appearance=light|dark|adaptive]
    [--token-adapters=css,delphi-vcl,delphi-fmx]
    [--token-output=.jerasoft/generated]
  jerasoft-brand context --profile=apply|audit|assets [--format=markdown|json] [--fresh]
  jerasoft-brand asset resolve <id> --copy-to=<destino> [--fresh]
  jerasoft-brand audit [--frozen] [--offline]
  jerasoft-brand sync [--fresh]
  jerasoft-brand upgrade --major
  jerasoft-brand logout [--purge-cache]
  jerasoft-brand --version

Sem argumentos, abre um menu navegável que detecta o projeto atual.

O pacote público transporta somente o protocolo. Contratos, skills e ativos
continuam protegidos na fonte privada e são resolvidos com autenticação.`;

export async function runCli(
  arguments_: string[],
  io: CliIo = defaultIo,
  execute = executeCommand,
  interactive: () => Promise<CliCommand | null> = runInteractiveMenu,
): Promise<number> {
  try {
    let command = parseArguments(arguments_);
    if (command.kind === "interactive") {
      const selected = await interactive();
      if (!selected) return EXIT_CODES.success;
      command = selected;
    }
    if (command.kind === "help") {
      io.stdout(help);
      return EXIT_CODES.success;
    }
    if (command.kind === "version") {
      io.stdout(packageMetadata.version);
      return EXIT_CODES.success;
    }

    return await execute(command, io);
  } catch (error) {
    io.stderr(safeErrorMessage(error));
    return error instanceof CliError
      ? error.exitCode
      : EXIT_CODES.usageOrConfiguration;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
