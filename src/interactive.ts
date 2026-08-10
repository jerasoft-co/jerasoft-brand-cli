import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";

import packageMetadata from "../package.json" with { type: "json" };

import type { CliCommand } from "./arguments";
import { EXIT_CODES } from "./constants";
import { CliError } from "./errors";
import { defaultTerminalState, type TerminalState } from "./io";
import { inspectProject, type ProjectInspection } from "./project";

interface PromptOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface InteractivePrompter {
  intro(message: string): void;
  note(message: string, title: string): void;
  select(
    message: string,
    options: PromptOption[],
    initialValue?: string,
  ): Promise<string | null>;
  text(
    message: string,
    placeholder: string,
    validate: (value: string | undefined) => string | undefined,
  ): Promise<string | null>;
  confirm(message: string, initialValue: boolean): Promise<boolean | null>;
  outro(message: string): void;
  cancel(message: string): void;
}

export const defaultPrompter: InteractivePrompter = {
  intro,
  note,
  async select(message, options, initialValue) {
    const result = await select<string>({
      message,
      options,
      maxItems: Math.min(options.length, 12),
      showInstructions: false,
      ...(initialValue === undefined ? {} : { initialValue }),
    });
    if (isCancel(result)) return null;
    return result;
  },
  async text(message, placeholder, validate) {
    const result = await text({ message, placeholder, validate });
    if (isCancel(result)) return null;
    return result;
  },
  async confirm(message, initialValue) {
    const result = await confirm({
      message,
      initialValue,
      active: "Sim",
      inactive: "Não",
    });
    if (isCancel(result)) return null;
    return result;
  },
  outro,
  cancel,
};

interface InteractiveOptions {
  projectRoot?: string;
  prompter?: InteractivePrompter;
  terminal?: TerminalState;
  inspect?: (projectRoot: string) => Promise<ProjectInspection>;
}

type InteractiveResult = CliCommand | "back" | "cancel";

function agentsDescription(inspection: ProjectInspection) {
  switch (inspection.agentsFile) {
    case "absent":
      return "será criado com um bloco gerenciado JeraSoft";
    case "existing":
      return "conteúdo existente será preservado; o bloco JeraSoft será acrescentado";
    case "managed":
      return "somente o bloco JeraSoft existente será atualizado";
    case "invalid-managed-block":
      return "possui marcadores JeraSoft incompletos e precisa ser corrigido";
  }
}

function projectSummary(projectRoot: string, inspection: ProjectInspection) {
  const type = inspection.existingProject
    ? `Projeto existente${inspection.signals.length > 0 ? ` (${inspection.signals.join(", ")})` : ""}`
    : "Diretório novo";
  const brand = inspection.brandInitialized
    ? `configurada${inspection.brandLockPresent ? " e com lock" : ", sem lock"}`
    : "ainda não configurada";
  return [
    `Diretório: ${projectRoot}`,
    `Detecção: ${type}`,
    `Marca: ${brand}`,
    `AGENTS.md: ${agentsDescription(inspection)}`,
    `Codex: ${inspection.codexDetected ? "detectado" : "não detectado"}`,
  ].join("\n");
}

async function chooseInit(
  inspection: ProjectInspection,
  prompter: InteractivePrompter,
): Promise<InteractiveResult> {
  if (inspection.agentsFile === "invalid-managed-block") {
    throw new CliError(
      "O AGENTS.md contém um bloco JeraSoft incompleto. Corrija os marcadores antes de inicializar.",
      EXIT_CODES.integrity,
    );
  }

  let adapter: "auto" | "generic" | "codex" = "auto";
  if (!inspection.brandInitialized) {
    const selected = await prompter.select(
      "Como os agentes devem receber o contrato?",
      [
        {
          value: "auto",
          label: "Detectar automaticamente",
          hint: inspection.codexDetected ? "Codex detectado" : "recomendado",
        },
        {
          value: "generic",
          label: "Somente AGENTS.md",
          hint: "compatível com qualquer agente",
        },
        {
          value: "codex",
          label: "AGENTS.md + skills do Codex",
          hint: "cria skills finas locais",
        },
        { value: "back", label: "Voltar ao menu principal" },
      ],
      "auto",
    );
    if (!selected) return "cancel";
    if (selected === "back") return "back";
    adapter = selected as typeof adapter;
  }

  if (inspection.existingProject) {
    const confirmed = await prompter.confirm(
      inspection.brandInitialized
        ? "Reconciliar a integração sem alterar o restante do projeto?"
        : "Integrar a marca preservando os arquivos existentes?",
      true,
    );
    if (confirmed === null) return "cancel";
    if (!confirmed) return "back";
  }
  return { kind: "init", dryRun: false, adapter };
}

async function chooseAsset(
  prompter: InteractivePrompter,
): Promise<InteractiveResult> {
  const id = await prompter.text(
    "Qual é o ID do ativo aprovado?",
    "logo.jerasoft.symbol.default",
    (value) => (value?.trim() ? undefined : "Informe o ID do ativo."),
  );
  if (!id) return "cancel";
  const copyTo = await prompter.text(
    "Onde o ativo deve ser materializado?",
    "assets/brand/jerasoft-symbol.svg",
    (value) =>
      value?.trim() ? undefined : "Informe um destino dentro do projeto.",
  );
  if (!copyTo) return "cancel";
  return {
    kind: "asset",
    id: id.trim(),
    copyTo: copyTo.trim(),
    fresh: false,
  };
}

async function commandFromSelection(
  selection: string,
  inspection: ProjectInspection,
  prompter: InteractivePrompter,
): Promise<InteractiveResult> {
  switch (selection) {
    case "init":
      return chooseInit(inspection, prompter);
    case "context-apply":
      return {
        kind: "context",
        profile: "apply",
        format: "markdown",
        fresh: false,
      };
    case "context-audit":
      return {
        kind: "context",
        profile: "audit",
        format: "markdown",
        fresh: false,
      };
    case "context-assets":
      return {
        kind: "context",
        profile: "assets",
        format: "markdown",
        fresh: false,
      };
    case "asset":
      return chooseAsset(prompter);
    case "sync":
      return { kind: "sync", fresh: false };
    case "audit":
      return { kind: "audit", frozen: true, offline: false };
    case "upgrade": {
      const confirmed = await prompter.confirm(
        "Confirmar a migração para um novo contrato major?",
        false,
      );
      if (confirmed === null) return "cancel";
      return confirmed ? { kind: "upgrade", major: true } : "back";
    }
    case "logout": {
      const purgeCache = await prompter.confirm(
        "Também remover o cache local verificado?",
        false,
      );
      return purgeCache === null ? "cancel" : { kind: "logout", purgeCache };
    }
    default:
      throw new CliError(
        "A opção selecionada não faz parte do menu atual.",
        EXIT_CODES.usageOrConfiguration,
      );
  }
}

function requiresInitialization(
  inspection: ProjectInspection,
  hint: string,
): Pick<PromptOption, "hint" | "disabled"> {
  return inspection.brandInitialized
    ? { hint }
    : { hint: "inicialize o projeto primeiro", disabled: true };
}

function commandCatalog(inspection: ProjectInspection): PromptOption[] {
  return [
    {
      value: "init",
      label: inspection.brandInitialized
        ? "Reconciliar integração do projeto"
        : "Inicializar a marca neste projeto",
      hint: "init",
      disabled: inspection.agentsFile === "invalid-managed-block",
    },
    {
      value: "context-apply",
      label: "Aplicar a marca",
      ...requiresInitialization(inspection, "context --profile=apply"),
    },
    {
      value: "context-audit",
      label: "Preparar auditoria de interface",
      ...requiresInitialization(inspection, "context --profile=audit"),
    },
    {
      value: "context-assets",
      label: "Consultar ativos aprovados",
      ...requiresInitialization(inspection, "context --profile=assets"),
    },
    {
      value: "asset",
      label: "Materializar um ativo",
      ...requiresInitialization(inspection, "asset resolve <id>"),
    },
    {
      value: "audit",
      label: "Validar lock e cache",
      hint: !inspection.brandInitialized
        ? "inicialize o projeto primeiro"
        : inspection.brandLockPresent
          ? "audit --frozen"
          : "sincronize o lock primeiro",
      disabled: !inspection.brandInitialized || !inspection.brandLockPresent,
    },
    {
      value: "sync",
      label: "Sincronizar a marca",
      ...requiresInitialization(inspection, "sync"),
    },
    {
      value: "upgrade",
      label: "Migrar contrato major",
      ...requiresInitialization(inspection, "upgrade --major"),
    },
    { value: "logout", label: "Encerrar sessão local", hint: "logout" },
    {
      value: "version",
      label: "Ver versão instalada",
      hint: `--version · ${packageMetadata.version}`,
    },
    { value: "back", label: "Voltar ao menu principal" },
  ];
}

async function chooseFromCommandCatalog(
  inspection: ProjectInspection,
  prompter: InteractivePrompter,
): Promise<InteractiveResult> {
  let initialValue = inspection.brandInitialized
    ? "context-apply"
    : inspection.agentsFile === "invalid-managed-block"
      ? "back"
      : "init";
  for (;;) {
    const selection = await prompter.select(
      "Qual ação você deseja executar?",
      commandCatalog(inspection),
      initialValue,
    );
    if (!selection) return "cancel";
    if (selection === "back") return "back";
    if (selection === "version") {
      prompter.note(packageMetadata.version, "Versão instalada");
      initialValue = "version";
      continue;
    }
    const result = await commandFromSelection(selection, inspection, prompter);
    if (result === "back") {
      prompter.note("Ação não confirmada.", "De volta aos comandos");
      initialValue = selection;
      continue;
    }
    return result;
  }
}

function mainMenuOptions(inspection: ProjectInspection): PromptOption[] {
  if (!inspection.brandInitialized) {
    return [
      {
        value: "init",
        label: inspection.existingProject
          ? "Integrar a marca a este projeto"
          : "Inicializar a marca neste diretório",
        hint:
          inspection.agentsFile === "invalid-managed-block"
            ? "corrija primeiro os marcadores de AGENTS.md"
            : "recomendado",
        disabled: inspection.agentsFile === "invalid-managed-block",
      },
      { value: "help", label: "Ver todos os comandos" },
      { value: "logout", label: "Encerrar sessão local" },
      { value: "exit", label: "Sair" },
    ];
  }

  return [
    {
      value: "context-apply",
      label: "Aplicar a marca",
      hint: "resolve contrato e diretrizes",
    },
    {
      value: "context-audit",
      label: "Auditar uma interface",
      hint: "contexto somente leitura",
    },
    {
      value: "context-assets",
      label: "Localizar ativos aprovados",
    },
    { value: "asset", label: "Materializar um ativo" },
    { value: "sync", label: "Sincronizar o lock da marca" },
    {
      value: "audit",
      label: "Validar lock e cache",
      ...(inspection.brandLockPresent
        ? {}
        : { hint: "sincronize o lock primeiro" }),
      disabled: !inspection.brandLockPresent,
    },
    {
      value: "init",
      label: "Reconciliar integração do projeto",
      hint:
        inspection.agentsFile === "invalid-managed-block"
          ? "corrija primeiro os marcadores de AGENTS.md"
          : "preserva conteúdo existente",
      disabled: inspection.agentsFile === "invalid-managed-block",
    },
    { value: "upgrade", label: "Migrar contrato major" },
    { value: "logout", label: "Encerrar sessão local" },
    { value: "help", label: "Ver todos os comandos" },
    { value: "exit", label: "Sair" },
  ];
}

export async function runInteractiveMenu(
  options: InteractiveOptions = {},
): Promise<CliCommand | null> {
  const terminal = options.terminal ?? defaultTerminalState;
  if (!terminal.interactive) {
    throw new CliError(
      "O menu interativo exige um terminal. Use --help para listar os comandos disponíveis.",
      EXIT_CODES.usageOrConfiguration,
    );
  }

  const projectRoot = options.projectRoot ?? process.cwd();
  const prompter = options.prompter ?? defaultPrompter;
  const inspection = await (options.inspect ?? inspectProject)(projectRoot);
  prompter.intro(`JeraSoft Brand CLI ${packageMetadata.version}`);
  prompter.note(projectSummary(projectRoot, inspection), "Projeto detectado");

  let initialValue = inspection.brandInitialized
    ? inspection.brandLockPresent
      ? "context-apply"
      : "sync"
    : inspection.agentsFile === "invalid-managed-block"
      ? "help"
      : "init";
  for (;;) {
    const selection = await prompter.select(
      "O que você deseja fazer?",
      mainMenuOptions(inspection),
      initialValue,
    );
    if (!selection) {
      prompter.cancel("Operação cancelada sem alterações.");
      return null;
    }
    if (selection === "exit") {
      prompter.outro("Até logo.");
      return null;
    }

    const result =
      selection === "help"
        ? await chooseFromCommandCatalog(inspection, prompter)
        : await commandFromSelection(selection, inspection, prompter);
    if (result === "back") {
      initialValue = selection;
      if (selection !== "help") {
        prompter.note("Ação não confirmada.", "De volta ao menu");
      }
      continue;
    }
    if (result === "cancel") {
      prompter.cancel("Operação cancelada sem alterações.");
      return null;
    }
    prompter.outro("Opção confirmada. Executando…");
    return result;
  }
}
