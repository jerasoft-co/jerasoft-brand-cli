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
): Promise<CliCommand | null> {
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
      ],
      "auto",
    );
    if (!selected) return null;
    adapter = selected as typeof adapter;
  }

  if (inspection.existingProject) {
    const confirmed = await prompter.confirm(
      inspection.brandInitialized
        ? "Reconciliar a integração sem alterar o restante do projeto?"
        : "Integrar a marca preservando os arquivos existentes?",
      true,
    );
    if (confirmed !== true) return null;
  }
  return { kind: "init", dryRun: false, adapter };
}

async function chooseAsset(
  prompter: InteractivePrompter,
): Promise<CliCommand | null> {
  const id = await prompter.text(
    "Qual é o ID do ativo aprovado?",
    "logo.jerasoft.symbol.default",
    (value) => (value?.trim() ? undefined : "Informe o ID do ativo."),
  );
  if (!id) return null;
  const copyTo = await prompter.text(
    "Onde o ativo deve ser materializado?",
    "assets/brand/jerasoft-symbol.svg",
    (value) =>
      value?.trim() ? undefined : "Informe um destino dentro do projeto.",
  );
  if (!copyTo) return null;
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
): Promise<CliCommand | null> {
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
      return confirmed === true ? { kind: "upgrade", major: true } : null;
    }
    case "logout": {
      const purgeCache = await prompter.confirm(
        "Também remover o cache local verificado?",
        false,
      );
      return purgeCache === null ? null : { kind: "logout", purgeCache };
    }
    case "help":
      return { kind: "help" };
    case "exit":
      return null;
    default:
      throw new CliError(
        "A opção selecionada não faz parte do menu atual.",
        EXIT_CODES.usageOrConfiguration,
      );
  }
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

  const optionsList: PromptOption[] = inspection.brandInitialized
    ? [
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
        { value: "audit", label: "Validar lock e cache" },
        {
          value: "init",
          label: "Reconciliar integração do projeto",
          hint: "preserva conteúdo existente",
        },
        { value: "upgrade", label: "Migrar contrato major" },
        { value: "logout", label: "Encerrar sessão local" },
        { value: "help", label: "Ver todos os comandos" },
        { value: "exit", label: "Sair" },
      ]
    : [
        {
          value: "init",
          label: inspection.existingProject
            ? "Integrar a marca a este projeto"
            : "Inicializar a marca neste diretório",
          hint: "recomendado",
        },
        { value: "help", label: "Ver todos os comandos" },
        { value: "logout", label: "Encerrar sessão local" },
        { value: "exit", label: "Sair" },
      ];
  const selection = await prompter.select(
    "O que você deseja fazer?",
    optionsList,
    inspection.brandInitialized ? "context-apply" : "init",
  );
  if (!selection) {
    prompter.cancel("Operação cancelada sem alterações.");
    return null;
  }
  if (selection === "exit") {
    prompter.outro("Até logo.");
    return null;
  }
  const command = await commandFromSelection(selection, inspection, prompter);
  if (!command) {
    prompter.cancel("Nenhuma alteração realizada.");
    return null;
  }
  prompter.outro("Opção confirmada. Executando…");
  return command;
}
