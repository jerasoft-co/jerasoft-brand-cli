import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli";
import { EXIT_CODES } from "../src/constants";

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
  test("informa a versão pública", () => {
    const capture = captureIo();
    expect(runCli(["--version"], capture.io)).toBe(EXIT_CODES.success);
    expect(capture.stdout).toEqual(["1.0.0"]);
    expect(capture.stderr).toEqual([]);
  });

  test("não finge executar comandos ainda não habilitados", () => {
    const capture = captureIo();
    expect(runCli(["context", "--profile=apply"], capture.io)).toBe(
      EXIT_CODES.usageOrConfiguration,
    );
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr[0]).toContain("será habilitado antes da publicação");
  });

  test("não expõe exceções inesperadas ao usuário", () => {
    const capture = captureIo();
    expect(runCli(["desconhecido"], capture.io)).toBe(
      EXIT_CODES.usageOrConfiguration,
    );
    expect(capture.stderr).toEqual(["Comando desconhecido: desconhecido."]);
  });
});
