import { describe, expect, test } from "bun:test";

import { parseArguments } from "../src/arguments";
import { CliError } from "../src/errors";

describe("parser público do CLI", () => {
  test("mantém help e version sem efeitos colaterais", () => {
    expect(parseArguments([])).toEqual({ kind: "help" });
    expect(parseArguments(["--version"])).toEqual({ kind: "version" });
  });

  test("interpreta init e context com opções explícitas", () => {
    expect(parseArguments(["init", "--dry-run", "--adapter=codex"])).toEqual({
      kind: "init",
      dryRun: true,
      adapter: "codex",
    });
    expect(
      parseArguments([
        "context",
        "--profile=audit",
        "--format=json",
        "--fresh",
      ]),
    ).toEqual({
      kind: "context",
      profile: "audit",
      format: "json",
      fresh: true,
    });
  });

  test("rejeita perfis e opções desconhecidas em pt-BR", () => {
    expect(() => parseArguments(["context", "--profile=outro"])).toThrow(
      CliError,
    );
    expect(() => parseArguments(["init", "--silencioso"])).toThrow(
      "Opção desconhecida",
    );
  });
});
