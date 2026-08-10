import { describe, expect, test } from "bun:test";

import { parseArguments } from "../src/arguments";
import { CliError } from "../src/errors";

describe("parser público do CLI", () => {
  test("abre o menu sem argumentos e mantém help e version explícitos", () => {
    expect(parseArguments([])).toEqual({ kind: "interactive" });
    expect(parseArguments(["--help"])).toEqual({ kind: "help" });
    expect(parseArguments(["--version"])).toEqual({ kind: "version" });
  });

  test("interpreta init e context com opções explícitas", () => {
    expect(parseArguments(["init", "--dry-run"])).toEqual({
      kind: "init",
      dryRun: true,
    });
    expect(
      parseArguments([
        "init",
        "--appearance=adaptive",
        "--token-adapters=css,delphi-fmx",
        "--token-output=design/tokens",
      ]),
    ).toEqual({
      kind: "init",
      dryRun: false,
      appearance: "adaptive",
      tokenAdapters: ["css", "delphi-fmx"],
      tokenOutput: "design/tokens",
    });
    expect(
      parseArguments([
        "asset",
        "resolve",
        "logo.jerasoft.symbol.default",
        "--copy-to=assets/brand/symbol.svg",
        "--fresh",
      ]),
    ).toEqual({
      kind: "asset",
      id: "logo.jerasoft.symbol.default",
      copyTo: "assets/brand/symbol.svg",
      fresh: true,
    });
    expect(parseArguments(["sync", "--fresh"])).toEqual({
      kind: "sync",
      fresh: true,
    });
    expect(parseArguments(["upgrade", "--major"])).toEqual({
      kind: "upgrade",
      major: true,
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

  test("traduz --adapter legado sem levar fornecedor ao domínio", () => {
    expect(parseArguments(["init", "--adapter=generic"])).toEqual({
      kind: "init",
      dryRun: false,
      artifacts: ["instructions"],
    });
    expect(parseArguments(["init", "--adapter=codex"])).toEqual({
      kind: "init",
      dryRun: false,
      artifacts: ["instructions", "skills"],
    });
  });

  test("rejeita perfis e opções desconhecidas em pt-BR", () => {
    expect(() => parseArguments(["context", "--profile=outro"])).toThrow(
      CliError,
    );
    expect(() => parseArguments(["init", "--silencioso"])).toThrow(
      "Opção desconhecida",
    );
    expect(() =>
      parseArguments(["init", "--token-adapters=css,desconhecido"]),
    ).toThrow("delphi-fmx");
    expect(() =>
      parseArguments(["asset", "resolve", "logo.jerasoft.symbol.default"]),
    ).toThrow("--copy-to");
  });
});
