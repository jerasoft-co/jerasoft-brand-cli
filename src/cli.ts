#!/usr/bin/env bun

import packageMetadata from "../package.json" with { type: "json" };

import { parseArguments } from "./arguments";
import { CLI_NAME, EXIT_CODES } from "./constants";
import { CliError, safeErrorMessage } from "./errors";

const help = `JeraSoft Brand CLI ${packageMetadata.version}

Uso:
  jerasoft-brand init [--dry-run] [--adapter=auto|generic|codex]
  jerasoft-brand context --profile=apply|audit|assets [--format=markdown|json] [--fresh]
  jerasoft-brand audit [--frozen] [--offline]
  jerasoft-brand logout [--purge-cache]
  jerasoft-brand --version

O pacote público transporta somente o protocolo. Contratos, skills e ativos
continuam protegidos na fonte privada e são resolvidos com autenticação.`;

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

const defaultIo: CliIo = {
  stdout: console.log,
  stderr: console.error,
};

export function runCli(arguments_: string[], io: CliIo = defaultIo): number {
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

    throw new CliError(
      `O comando ${command.kind} está reservado pelo protocolo v1 e será habilitado antes da publicação de ${CLI_NAME}@${packageMetadata.version}.`,
      EXIT_CODES.usageOrConfiguration,
    );
  } catch (error) {
    io.stderr(safeErrorMessage(error));
    return error instanceof CliError
      ? error.exitCode
      : EXIT_CODES.usageOrConfiguration;
  }
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
