#!/usr/bin/env bun

import packageMetadata from "../package.json" with { type: "json" };

import { parseArguments } from "./arguments";
import { executeCommand } from "./commands";
import { EXIT_CODES } from "./constants";
import { CliError, safeErrorMessage } from "./errors";
import { defaultIo, type CliIo } from "./io";

const help = `JeraSoft Brand CLI ${packageMetadata.version}

Uso:
  jerasoft-brand init [--dry-run] [--adapter=auto|generic|codex]
  jerasoft-brand context --profile=apply|audit|assets [--format=markdown|json] [--fresh]
  jerasoft-brand asset resolve <id> --copy-to=<destino> [--fresh]
  jerasoft-brand audit [--frozen] [--offline]
  jerasoft-brand sync [--fresh]
  jerasoft-brand upgrade --major
  jerasoft-brand logout [--purge-cache]
  jerasoft-brand --version

O pacote público transporta somente o protocolo. Contratos, skills e ativos
continuam protegidos na fonte privada e são resolvidos com autenticação.`;

export async function runCli(
  arguments_: string[],
  io: CliIo = defaultIo,
  execute = executeCommand,
): Promise<number> {
  try {
    const command = parseArguments(arguments_);
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
