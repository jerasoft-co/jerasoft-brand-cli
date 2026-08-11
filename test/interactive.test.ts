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
    agentSkills: { state: "managed", installed: 3, total: 3 },
    signals: ["Next.js", "Git", "AGENTS.md"],
    ...overrides,
  };
}

function run(
  prompter: ScriptedPrompter,
  project: ProjectInspection,
  colors = false,
) {
  return runInteractiveMenu({
    projectRoot: "/workspace/existente",
    prompter,
    terminal: { interactive: true },
    colors,
    inspect: () => Promise.resolve(project),
  });
}

describe("menu interativo", () => {
  test("detecta projeto existente e confirma integração preservando arquivos", async () => {
    const prompter = new ScriptedPrompter(["init"], [], [true]);
    expect(await run(prompter, inspection())).toEqual({
      kind: "init",
      dryRun: false,
    });
    expect(prompter.messages.join("\n")).toContain("✓ Projeto      Existente");
    expect(prompter.messages.join("\n")).toContain(
      "! AGENTS.md    Existente · o conteúdo será preservado",
    );
    expect(prompter.messages.join("\n")).toContain(
      "✓ Agent Skills 3 skills JeraSoft integradas",
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
      label: "Consultar instruções de aplicação",
      hint: "context --profile=apply · somente leitura",
    });
  });

  test("usa a atualização real como ação principal do projeto configurado", async () => {
    const prompter = new ScriptedPrompter(["sync"]);
    expect(
      await run(
        prompter,
        inspection({
          brandInitialized: true,
          brandLockPresent: true,
          agentsFile: "managed",
        }),
      ),
    ).toEqual({ kind: "sync", fresh: false });
    expect(prompter.menus[0]?.initialValue).toBe("sync");
    expect(prompter.menus[0]?.options[0]).toMatchObject({
      value: "sync",
      label: "Atualizar integração da marca",
      disabled: false,
    });
    expect(
      prompter.menus[0]?.options.find(
        (option) => option.value === "context-apply",
      ),
    ).toMatchObject({
      label: "Consultar contrato e instruções",
      hint: "somente leitura",
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
      label: "Consultar instruções de aplicação",
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

  test("volta ao menu ao recusar a integração sem tratar como cancelamento", async () => {
    const prompter = new ScriptedPrompter(["init", "exit"], [], [false]);
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
    expect(prompter.messages.join("\n")).toContain(
      "× AGENTS.md    Bloqueado · corrija os marcadores JeraSoft",
    );
  });

  test("sinaliza conflito em Agent Skills antes da inicialização", async () => {
    const prompter = new ScriptedPrompter(["exit"]);
    expect(
      await run(
        prompter,
        inspection({
          agentSkills: { state: "conflict", installed: 0, total: 3 },
        }),
      ),
    ).toBeNull();
    expect(
      prompter.menus[0]?.options.find((option) => option.value === "init"),
    ).toMatchObject({
      hint: "resolva primeiro o conflito em Agent Skills",
      disabled: true,
    });
    expect(prompter.messages.join("\n")).toContain(
      "× Agent Skills Conflito · uma skill existente não é gerenciada",
    );
  });

  test("colore semanticamente os estados do projeto", async () => {
    const prompter = new ScriptedPrompter(["exit"]);
    expect(
      await run(
        prompter,
        inspection({
          brandInitialized: true,
          brandLockPresent: true,
          agentsFile: "managed",
          agentSkills: { state: "absent", installed: 0, total: 3 },
        }),
        true,
      ),
    ).toBeNull();
    const output = prompter.messages.join("\n");
    expect(output).toContain("\u001B[32m✓\u001B[39m");
    expect(output).toContain("\u001B[33m!\u001B[39m");
    expect(output).toContain("Configurada · lock presente");
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
