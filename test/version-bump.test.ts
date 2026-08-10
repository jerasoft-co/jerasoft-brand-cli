import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  bumpVersion,
  nextVersion,
  parseVersionBumpArguments,
  type VersionBumpKind,
  type VersionBumpPrompter,
} from "../tooling/version-bump";

const temporaryRoots: string[] = [];

class ScriptedVersionPrompter implements VersionBumpPrompter {
  readonly messages: string[] = [];
  readonly menus: {
    message: string;
    options: { value: string; label: string; hint?: string }[];
    initialValue: VersionBumpKind;
  }[] = [];

  constructor(
    private readonly selection: VersionBumpKind | "exit" | null,
    private readonly confirmation: boolean | null = true,
  ) {}

  intro(message: string) {
    this.messages.push(`intro:${message}`);
  }

  select(
    message: string,
    options: {
      value: VersionBumpKind | "exit";
      label: string;
      hint?: string;
    }[],
    initialValue: VersionBumpKind,
  ) {
    this.menus.push({ message, options, initialValue });
    return Promise.resolve(this.selection);
  }

  confirm(message: string, initialValue: boolean) {
    this.messages.push(`confirm:${message}:${String(initialValue)}`);
    return Promise.resolve(this.confirmation);
  }

  outro(message: string) {
    this.messages.push(`outro:${message}`);
  }

  cancel(message: string) {
    this.messages.push(`cancel:${message}`);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function versionFixture(version = "1.2.3") {
  const root = await mkdtemp(path.join(tmpdir(), "jerasoft-version-test-"));
  temporaryRoots.push(root);
  const packageContents = `${JSON.stringify(
    { name: "@jerasoft/brand", version, private: true },
    null,
    2,
  )}\n`;
  const lockContents = '{ "lockfileVersion": 1 }\n';
  await Promise.all([
    writeFile(path.join(root, "package.json"), packageContents),
    writeFile(path.join(root, "bun.lock"), lockContents),
  ]);
  return { root, packageContents, lockContents };
}

describe("bump controlado de versão", () => {
  test("incrementa build, minor e major com resets SemVer", () => {
    expect(nextVersion("1.2.9", "build")).toBe("1.2.10");
    expect(nextVersion("1.2.9", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.9", "major")).toBe("2.0.0");
  });

  test("aceita menu, parâmetros e help, mas rejeita ambiguidades", () => {
    expect(parseVersionBumpArguments(["build", "--dry-run"])).toEqual({
      kind: "build",
      dryRun: true,
      help: false,
    });
    expect(parseVersionBumpArguments([])).toEqual({
      kind: null,
      dryRun: false,
      help: false,
    });
    expect(parseVersionBumpArguments(["--help"])).toEqual({
      kind: null,
      dryRun: false,
      help: true,
    });
    expect(() => parseVersionBumpArguments(["patch"])).toThrow("Uso:");
    expect(() => parseVersionBumpArguments(["minor", "major"])).toThrow("Uso:");
    expect(() => parseVersionBumpArguments(["build", "--tag"])).toThrow(
      "Opção desconhecida",
    );
  });

  test("abre menu navegável com as próximas versões e confirma a escrita", async () => {
    const fixture = await versionFixture();
    const prompter = new ScriptedVersionPrompter("minor", true);
    const result = await bumpVersion([], {
      repositoryRoot: fixture.root,
      interactive: true,
      prompter,
      stdout: () => undefined,
      runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(result).toMatchObject({
      currentVersion: "1.2.3",
      version: "1.3.0",
      kind: "minor",
      changed: true,
    });
    expect(prompter.menus).toHaveLength(1);
    expect(prompter.menus[0]).toMatchObject({
      message: "Qual incremento você deseja aplicar?",
      initialValue: "build",
    });
    expect(prompter.menus[0]?.options).toEqual([
      {
        value: "build",
        label: "Build de correção",
        hint: "1.2.4 · patch SemVer",
      },
      {
        value: "minor",
        label: "Versão minor",
        hint: "1.3.0 · novas mudanças compatíveis",
      },
      {
        value: "major",
        label: "Versão major",
        hint: "2.0.0 · mudanças incompatíveis",
      },
      { value: "exit", label: "Sair sem alterar" },
    ]);
    expect(prompter.messages).toContain(
      "confirm:Atualizar 1.2.3 para 1.3.0?:false",
    );
    expect(prompter.messages.at(-1)).toBe(
      "outro:Versão atualizada: 1.2.3 → 1.3.0. Execute bun run check.",
    );
  });

  test("sai do menu sem alterar arquivos nem executar comandos", async () => {
    const fixture = await versionFixture();
    const prompter = new ScriptedVersionPrompter("exit");
    let commands = 0;
    const result = await bumpVersion([], {
      repositoryRoot: fixture.root,
      interactive: true,
      prompter,
      stdout: () => undefined,
      runCommand: () => {
        commands += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toMatchObject({ changed: false, cancelled: true });
    expect(commands).toBe(0);
    expect(
      await readFile(path.join(fixture.root, "package.json"), "utf8"),
    ).toBe(fixture.packageContents);
    expect(prompter.messages.at(-1)).toBe(
      "cancel:Nenhuma alteração realizada.",
    );
  });

  test("trata Ctrl+C como cancelamento limpo", async () => {
    const fixture = await versionFixture();
    const prompter = new ScriptedVersionPrompter(null);
    const result = await bumpVersion([], {
      repositoryRoot: fixture.root,
      interactive: true,
      prompter,
      stdout: () => undefined,
    });

    expect(result).toMatchObject({ changed: false, cancelled: true });
    expect(prompter.messages.at(-1)).toBe(
      "cancel:Nenhuma alteração realizada.",
    );
  });

  test("recusa menu sem TTY e orienta o uso por parâmetros", async () => {
    const fixture = await versionFixture();
    expect(
      bumpVersion([], {
        repositoryRoot: fixture.root,
        interactive: false,
      }),
    ).rejects.toThrow("Informe build, minor ou major");
  });

  test("pré-visualiza sem gravar nem sincronizar o lock", async () => {
    const fixture = await versionFixture();
    const messages: string[] = [];
    let commands = 0;
    const result = await bumpVersion(["minor", "--dry-run"], {
      repositoryRoot: fixture.root,
      stdout: (message) => messages.push(message),
      runCommand: () => {
        commands += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toEqual({
      currentVersion: "1.2.3",
      version: "1.3.0",
      kind: "minor",
      changed: false,
    });
    expect(commands).toBe(0);
    expect(
      await readFile(path.join(fixture.root, "package.json"), "utf8"),
    ).toBe(fixture.packageContents);
    expect(messages.join("\n")).toContain("Nenhum arquivo foi alterado");
  });

  test("grava package.json e sincroniza bun.lock sem executar scripts", async () => {
    const fixture = await versionFixture();
    const commands: { command: string; args: string[]; cwd: string }[] = [];
    const result = await bumpVersion(["build"], {
      repositoryRoot: fixture.root,
      stdout: () => undefined,
      runCommand: (command, args, cwd) => {
        commands.push({ command, args, cwd });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.version).toBe("1.2.4");
    expect(
      JSON.parse(
        await readFile(path.join(fixture.root, "package.json"), "utf8"),
      ),
    ).toEqual({ name: "@jerasoft/brand", version: "1.2.4", private: true });
    expect(commands).toEqual([
      {
        command: "bun",
        args: ["install", "--lockfile-only", "--ignore-scripts"],
        cwd: fixture.root,
      },
    ]);
  });

  test("restaura os dois arquivos quando a sincronização falha", async () => {
    const fixture = await versionFixture();

    expect(
      bumpVersion(["major"], {
        repositoryRoot: fixture.root,
        stdout: () => undefined,
        runCommand: () => ({
          status: 1,
          stdout: "",
          stderr: "lock inválido",
        }),
      }),
    ).rejects.toThrow("lock inválido");
    expect(
      await readFile(path.join(fixture.root, "package.json"), "utf8"),
    ).toBe(fixture.packageContents);
    expect(await readFile(path.join(fixture.root, "bun.lock"), "utf8")).toBe(
      fixture.lockContents,
    );
  });
});
