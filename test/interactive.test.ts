import { describe, expect, test } from "bun:test";

import packageMetadata from "../package.json" with { type: "json" };

import {
  runInteractiveMenu,
  type InteractivePrompter,
} from "../src/interactive";
import type { ProjectInspection } from "../src/project";

class ScriptedPrompter implements InteractivePrompter {
  readonly messages: string[] = [];
  readonly menus: {
    message: string;
    options: {
      value: string;
      label: string;
      hint?: string;
      disabled?: boolean;
    }[];
    initialValue?: string;
  }[] = [];

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

  select(
    message: string,
    options: {
      value: string;
      label: string;
      hint?: string;
      disabled?: boolean;
    }[],
    initialValue?: string,
  ) {
    this.menus.push({
      message,
      options,
      ...(initialValue === undefined ? {} : { initialValue }),
    });
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

  test("abre todos os comandos como catálogo navegável sem encerrar a CLI", async () => {
    const prompter = new ScriptedPrompter(["help", "context-assets"]);
    expect(
      await run(
        prompter,
        inspection({
          brandInitialized: true,
          brandLockPresent: true,
          agentsFile: "managed",
        }),
      ),
    ).toEqual({
      kind: "context",
      profile: "assets",
      format: "markdown",
      fresh: false,
    });
    expect(prompter.menus.map((menu) => menu.message)).toEqual([
      "O que você deseja fazer?",
      "Qual ação você deseja executar?",
    ]);
    expect(prompter.menus[1]?.options.map((option) => option.value)).toEqual([
      "init",
      "context-apply",
      "context-audit",
      "context-assets",
      "asset",
      "audit",
      "sync",
      "upgrade",
      "logout",
      "version",
      "back",
    ]);
    expect(
      prompter.menus[1]?.options.find(
        (option) => option.value === "context-apply",
      ),
    ).toMatchObject({
      label: "Aplicar a marca",
      hint: "context --profile=apply",
    });
  });

  test("permite consultar a versão e voltar do catálogo ao menu principal", async () => {
    const prompter = new ScriptedPrompter(["help", "version", "back", "exit"]);
    expect(await run(prompter, inspection())).toBeNull();
    expect(prompter.messages).toContain(
      `note:Versão instalada:${packageMetadata.version}`,
    );
    expect(prompter.messages).toContain("outro:Até logo.");
    expect(prompter.menus).toHaveLength(4);
    expect(prompter.menus.map((menu) => menu.initialValue)).toEqual([
      "init",
      "init",
      "version",
      "help",
    ]);
  });

  test("mantém comandos dependentes visíveis e desabilitados antes do init", async () => {
    const prompter = new ScriptedPrompter(["help", "back", "exit"]);
    expect(await run(prompter, inspection())).toBeNull();
    const catalog = prompter.menus[1];
    expect(
      catalog?.options.find((option) => option.value === "context-apply"),
    ).toMatchObject({
      label: "Aplicar a marca",
      hint: "inicialize o projeto primeiro",
      disabled: true,
    });
    expect(
      catalog?.options.find((option) => option.value === "sync"),
    ).toMatchObject({ disabled: true });
  });

  test("volta ao menu ao recusar uma ação destrutiva", async () => {
    const prompter = new ScriptedPrompter(["upgrade", "exit"], [], [false]);
    expect(
      await run(
        prompter,
        inspection({ brandInitialized: true, brandLockPresent: true }),
      ),
    ).toBeNull();
    expect(prompter.messages).toContain(
      "note:De volta ao menu:Ação não confirmada.",
    );
    expect(prompter.messages).toContain("outro:Até logo.");
  });

  test("oferece voltar durante a configuração sem tratar como cancelamento", async () => {
    const prompter = new ScriptedPrompter(["init", "back", "exit"]);
    expect(await run(prompter, inspection())).toBeNull();
    expect(prompter.messages).toContain(
      "note:De volta ao menu:Ação não confirmada.",
    );
    expect(prompter.messages).toContain("outro:Até logo.");
    expect(
      prompter.messages.some((message) => message.startsWith("cancel:")),
    ).toBe(false);
  });

  test("trata Ctrl+C em uma etapa interna como cancelamento da CLI", async () => {
    const prompter = new ScriptedPrompter(["upgrade"], [], [null]);
    expect(
      await run(
        prompter,
        inspection({ brandInitialized: true, brandLockPresent: true }),
      ),
    ).toBeNull();
    expect(prompter.messages).toContain(
      "cancel:Operação cancelada sem alterações.",
    );
    expect(prompter.menus).toHaveLength(1);
  });

  test("diferencia logout simples de logout com limpeza de cache", async () => {
    const keepCache = new ScriptedPrompter(["logout"], [], [false]);
    expect(await run(keepCache, inspection())).toEqual({
      kind: "logout",
      purgeCache: false,
    });

    const purgeCache = new ScriptedPrompter(["logout"], [], [true]);
    expect(await run(purgeCache, inspection())).toEqual({
      kind: "logout",
      purgeCache: true,
    });
  });

  test("não oferece auditoria sem um lock da marca", async () => {
    const prompter = new ScriptedPrompter(["exit"]);
    expect(
      await run(prompter, inspection({ brandInitialized: true })),
    ).toBeNull();
    expect(
      prompter.menus[0]?.options.find((option) => option.value === "audit"),
    ).toMatchObject({ disabled: true });
  });

  test("desabilita init inválido e inicia o cursor em uma ação segura", async () => {
    const prompter = new ScriptedPrompter(["exit"]);
    expect(
      await run(prompter, inspection({ agentsFile: "invalid-managed-block" })),
    ).toBeNull();
    expect(
      prompter.menus[0]?.options.find((option) => option.value === "init"),
    ).toMatchObject({ disabled: true });
    expect(prompter.menus[0]?.initialValue).toBe("help");
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
