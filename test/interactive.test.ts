import { describe, expect, test } from "bun:test";

import {
  runInteractiveMenu,
  type InteractivePrompter,
} from "../src/interactive";
import type { ProjectInspection } from "../src/project";

class ScriptedPrompter implements InteractivePrompter {
  readonly messages: string[] = [];

  constructor(
    private readonly selections: (string | null)[],
    private readonly texts: (string | null)[] = [],
    private readonly confirmations: (boolean | null)[] = [],
  ) {}

  intro(message: string) {
    this.messages.push(`intro:${message}`);
  }

  note(message: string, title: string) {
    this.messages.push(`note:${title}:${message}`);
  }

  select() {
    return Promise.resolve(this.selections.shift() ?? null);
  }

  text() {
    return Promise.resolve(this.texts.shift() ?? null);
  }

  confirm() {
    return Promise.resolve(this.confirmations.shift() ?? null);
  }

  outro(message: string) {
    this.messages.push(`outro:${message}`);
  }

  cancel(message: string) {
    this.messages.push(`cancel:${message}`);
  }
}

function inspection(
  overrides: Partial<ProjectInspection> = {},
): ProjectInspection {
  return {
    existingProject: true,
    brandInitialized: false,
    brandLockPresent: false,
    agentsFile: "existing",
    codexDetected: true,
    signals: ["Next.js", "Git", "AGENTS.md"],
    ...overrides,
  };
}

function run(prompter: ScriptedPrompter, project: ProjectInspection) {
  return runInteractiveMenu({
    projectRoot: "/workspace/existente",
    prompter,
    terminal: { interactive: true },
    inspect: () => Promise.resolve(project),
  });
}

describe("menu interativo", () => {
  test("detecta projeto existente e confirma integração preservando arquivos", async () => {
    const prompter = new ScriptedPrompter(["init", "auto"], [], [true]);
    expect(await run(prompter, inspection())).toEqual({
      kind: "init",
      dryRun: false,
      adapter: "auto",
    });
    expect(prompter.messages.join("\n")).toContain("Projeto existente");
    expect(prompter.messages.join("\n")).toContain(
      "conteúdo existente será preservado",
    );
  });

  test("oferece ações de manutenção quando a marca já está configurada", async () => {
    const prompter = new ScriptedPrompter(["context-assets"]);
    expect(
      await run(
        prompter,
        inspection({ brandInitialized: true, agentsFile: "managed" }),
      ),
    ).toEqual({
      kind: "context",
      profile: "assets",
      format: "markdown",
      fresh: false,
    });
  });

  test("coleta ID e destino ao materializar um ativo", async () => {
    const prompter = new ScriptedPrompter(
      ["asset"],
      ["logo.jerasoft.symbol.default", "assets/brand/symbol.svg"],
    );
    expect(await run(prompter, inspection({ brandInitialized: true }))).toEqual(
      {
        kind: "asset",
        id: "logo.jerasoft.symbol.default",
        copyTo: "assets/brand/symbol.svg",
        fresh: false,
      },
    );
  });

  test("cancela sem comando e não tenta inicializar bloco inválido", async () => {
    const cancelled = new ScriptedPrompter([null]);
    expect(await run(cancelled, inspection())).toBeNull();
    expect(cancelled.messages).toContain(
      "cancel:Operação cancelada sem alterações.",
    );

    const invalid = new ScriptedPrompter(["init"]);
    expect(
      run(invalid, inspection({ agentsFile: "invalid-managed-block" })),
    ).rejects.toThrow("marcadores");
  });

  test("sai pelo menu sem apresentar a saída como erro", async () => {
    const prompter = new ScriptedPrompter(["exit"]);
    expect(await run(prompter, inspection())).toBeNull();
    expect(prompter.messages).toContain("outro:Até logo.");
    expect(
      prompter.messages.some((message) => message.startsWith("cancel:")),
    ).toBe(false);
  });

  test("recusa ambiente sem TTY em vez de bloquear automação", () => {
    expect(
      runInteractiveMenu({
        terminal: { interactive: false },
      }),
    ).rejects.toThrow("exige um terminal");
  });
});
