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
  colors?: boolean;
}

type InteractiveResult = CliCommand | "back" | "cancel";

type StatusTone = "info" | "success" | "warning" | "danger" | "muted";

const toneCodes: Record<StatusTone, [open: string, close: string]> = {
  info: ["\u001B[36m", "\u001B[39m"],
  success: ["\u001B[32m", "\u001B[39m"],
  warning: ["\u001B[33m", "\u001B[39m"],
  danger: ["\u001B[31m", "\u001B[39m"],
  muted: ["\u001B[2m", "\u001B[22m"],
};

function paint(value: string, tone: StatusTone, colors: boolean) {
  if (!colors) return value;
  const [open, close] = toneCodes[tone];
  return `${open}${value}${close}`;
}

function statusLine(
  symbol: string,
  tone: StatusTone,
  label: string,
  value: string,
  colors: boolean,
) {
  const paddedLabel = label.padEnd(12);
  return `${paint(symbol, tone, colors)} ${paint(paddedLabel, "info", colors)} ${paint(value, tone, colors)}`;
}

function colorsSupported() {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0") {
    return false;
  }
  return process.env.FORCE_COLOR !== undefined || process.env.TERM !== "dumb";
}

function agentsStatus(inspection: ProjectInspection) {
  switch (inspection.agentsFile) {
    case "absent":
      return {
        symbol: "!",
        tone: "warning" as const,
        value: "Ausente · o arquivo será criado",
      };
    case "existing":
      return {
        symbol: "!",
        tone: "warning" as const,
        value: "Existente · o conteúdo será preservado",
      };
    case "managed":
      return {
        symbol: "✓",
        tone: "success" as const,
        value: "Integrado · somente o bloco gerenciado será atualizado",
      };
    case "invalid-managed-block":
      return {
        symbol: "×",
        tone: "danger" as const,
        value: "Bloqueado · corrija os marcadores JeraSoft",
      };
  }
}

function agentSkillsStatus(inspection: ProjectInspection) {
  const { state, installed, total } = inspection.agentSkills;
  switch (state) {
    case "absent":
      return {
        symbol: "!",
        tone: "warning" as const,
        value: `Ausentes · ${String(total)} skills serão criadas`,
      };
    case "partial":
      return {
        symbol: "!",
        tone: "warning" as const,
        value: `Parciais · ${String(installed)}/${String(total)} instaladas`,
      };
    case "managed":
      return {
        symbol: "✓",
        tone: "success" as const,
        value: `${String(total)} skills JeraSoft integradas`,
      };
    case "conflict":
      return {
        symbol: "×",
        tone: "danger" as const,
        value: "Conflito · uma skill existente não é gerenciada",
      };
  }
}

function integrationBlockHint(inspection: ProjectInspection) {
  if (inspection.agentsFile === "invalid-managed-block") {
    return "corrija primeiro os marcadores de AGENTS.md";
  }
  if (inspection.agentSkills.state === "conflict") {
    return "resolva primeiro o conflito em Agent Skills";
  }
  return undefined;
}

function integrationBlocked(inspection: ProjectInspection) {
  return integrationBlockHint(inspection) !== undefined;
}

function syncAvailability(
  inspection: ProjectInspection,
): Pick<PromptOption, "hint" | "disabled"> {
  if (!inspection.brandInitialized) {
    return { hint: "inicialize o projeto primeiro", disabled: true };
  }
  const blockedHint = integrationBlockHint(inspection);
  return blockedHint
    ? { hint: blockedHint, disabled: true }
    : {
        hint: "atualiza configuração, lock, tokens e instruções",
        disabled: false,
      };
}

function projectSummary(
  projectRoot: string,
  inspection: ProjectInspection,
  colors: boolean,
) {
  const project = inspection.existingProject
    ? {
        symbol: "✓",
        tone: "success" as const,
        value: `Existente${inspection.signals.length > 0 ? ` · ${inspection.signals.join(", ")}` : ""}`,
      }
    : { symbol: "○", tone: "info" as const, value: "Diretório novo" };
  const brand = !inspection.brandInitialized
    ? { symbol: "!", tone: "warning" as const, value: "Não configurada" }
    : inspection.brandLockPresent
      ? {
          symbol: "✓",
          tone: "success" as const,
          value: "Configurada · lock presente",
        }
      : {
          symbol: "!",
          tone: "warning" as const,
          value: "Configurada · lock ausente",
        };
  const agents = agentsStatus(inspection);
  const agentSkills = agentSkillsStatus(inspection);
  return [
    statusLine("›", "info", "Diretório", projectRoot, colors),
    statusLine(project.symbol, project.tone, "Projeto", project.value, colors),
    statusLine(brand.symbol, brand.tone, "Marca", brand.value, colors),
    statusLine(agents.symbol, agents.tone, "AGENTS.md", agents.value, colors),
    statusLine(
      agentSkills.symbol,
      agentSkills.tone,
      "Agent Skills",
      agentSkills.value,
      colors,
    ),
  ].join("\n");
}

async function chooseInit(
  inspection: ProjectInspection,
  prompter: InteractivePrompter,
): Promise<InteractiveResult> {
  if (integrationBlocked(inspection)) {
    throw new CliError(
      inspection.agentsFile === "invalid-managed-block"
        ? "O AGENTS.md contém um bloco JeraSoft incompleto. Corrija os marcadores antes de inicializar."
        : "Uma Agent Skill JeraSoft existente não é gerenciada pelo CLI. Preserve ou renomeie o arquivo antes de inicializar.",
      EXIT_CODES.integrity,
    );
  }

  if (inspection.existingProject) {
    const detectedAdapters = [
      ...(inspection.signals.some((signal) =>
        new Set(["Next.js", "Vite"]).has(signal),
      )
        ? ["CSS"]
        : []),
      ...(inspection.signals.includes("Delphi VCL") ? ["Delphi VCL"] : []),
      ...(inspection.signals.includes("Delphi FMX")
        ? ["Delphi FireMonkey"]
        : []),
    ];
    const adapterNotice =
      detectedAdapters.length > 0
        ? ` Os adapters detectados (${detectedAdapters.join(", ")}) serão materializados; use as opções explícitas de init para alterar a seleção.`
        : "";
    const confirmed = await prompter.confirm(
      inspection.brandInitialized
        ? `Reconciliar a integração sem alterar o restante do projeto?${adapterNotice}`
        : `Integrar a marca preservando os arquivos existentes?${adapterNotice}`,
      true,
    );
    if (confirmed === null) return "cancel";
    if (!confirmed) return "back";
  }
  return { kind: "init", dryRun: false };
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
      disabled: integrationBlocked(inspection),
    },
    {
      value: "context-apply",
      label: "Consultar instruções de aplicação",
      ...requiresInitialization(
        inspection,
        "context --profile=apply · somente leitura",
      ),
    },
    {
      value: "context-audit",
      label: "Consultar instruções de auditoria",
      ...requiresInitialization(
        inspection,
        "context --profile=audit · somente leitura",
      ),
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
      label: "Atualizar integração da marca",
      ...syncAvailability(inspection),
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
    ? integrationBlocked(inspection)
      ? "context-apply"
      : "sync"
    : integrationBlocked(inspection)
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
        hint: integrationBlockHint(inspection) ?? "recomendado",
        disabled: integrationBlocked(inspection),
      },
      { value: "help", label: "Ver todos os comandos" },
      { value: "logout", label: "Encerrar sessão local" },
      { value: "exit", label: "Sair" },
    ];
  }

  return [
    {
      value: "sync",
      label: "Atualizar integração da marca",
      ...syncAvailability(inspection),
    },
    {
      value: "context-apply",
      label: "Consultar contrato e instruções",
      hint: "somente leitura",
    },
    {
      value: "context-audit",
      label: "Consultar instruções de auditoria",
      hint: "somente leitura",
    },
    {
      value: "context-assets",
      label: "Localizar ativos aprovados",
    },
    { value: "asset", label: "Materializar um ativo" },
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
      hint: integrationBlockHint(inspection) ?? "preserva conteúdo existente",
      disabled: integrationBlocked(inspection),
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
  const colors = options.colors ?? colorsSupported();
  prompter.intro(`JeraSoft Brand CLI ${packageMetadata.version}`);
  prompter.note(
    projectSummary(projectRoot, inspection, colors),
    "Projeto detectado",
  );

  let initialValue = inspection.brandInitialized
    ? integrationBlocked(inspection)
      ? "context-apply"
      : "sync"
    : integrationBlocked(inspection)
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
