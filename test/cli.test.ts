import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli";
import { EXIT_CODES } from "../src/constants";
import { CliError } from "../src/errors";

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}

describe("entrada do CLI", () => {
  test("informa a versão pública", async () => {
    const capture = captureIo();
    expect(await runCli(["--version"], capture.io)).toBe(EXIT_CODES.success);
    expect(capture.stdout).toEqual(["1.0.0"]);
    expect(capture.stderr).toEqual([]);
  });

  test("executa comandos habilitados pelo protocolo", async () => {
    const capture = captureIo();
    expect(
      await runCli(["context", "--profile=apply"], capture.io, (command) => {
        expect(command.kind).toBe("context");
        return Promise.resolve(EXIT_CODES.success);
      }),
    ).toBe(EXIT_CODES.success);
    expect(capture.stderr).toEqual([]);
  });

  test("propaga erros seguros dos comandos", async () => {
    const capture = captureIo();
    expect(
      await runCli(["context", "--profile=apply"], capture.io, () =>
        Promise.reject(
          new CliError(
            "Falha com ghu_token-secreto.",
            EXIT_CODES.authentication,
          ),
        ),
      ),
    ).toBe(EXIT_CODES.authentication);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(["Falha com [REDACTED]."]);
  });

  test("não expõe exceções inesperadas ao usuário", async () => {
    const capture = captureIo();
    expect(await runCli(["desconhecido"], capture.io)).toBe(
      EXIT_CODES.usageOrConfiguration,
    );
    expect(capture.stderr).toEqual(["Comando desconhecido: desconhecido."]);
  });
});
