import { CliError } from "./errors";
import { EXIT_CODES } from "./constants";

export type Profile = "apply" | "audit" | "assets";
export type OutputFormat = "markdown" | "json";

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init"; dryRun: boolean; adapter: "auto" | "generic" | "codex" }
  | { kind: "context"; profile: Profile; format: OutputFormat; fresh: boolean }
  | { kind: "audit"; frozen: boolean; offline: boolean }
  | { kind: "logout"; purgeCache: boolean };

function readOption(arguments_: string[], name: string) {
  const prefix = `--${name}=`;
  const values = arguments_
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length > 1) {
    throw new CliError(
      `Informe --${name} apenas uma vez.`,
      EXIT_CODES.usageOrConfiguration,
    );
  }
  return values[0];
}

function rejectUnknown(arguments_: string[], known: Set<string>) {
  const unknown = arguments_.find(
    (argument) =>
      !known.has(argument) &&
      ![...known].some(
        (entry) => entry.endsWith("=") && argument.startsWith(entry),
      ),
  );
  if (unknown) {
    throw new CliError(
      `Opção desconhecida: ${unknown}.`,
      EXIT_CODES.usageOrConfiguration,
    );
  }
}

export function parseArguments(arguments_: string[]): CliCommand {
  const firstArgument = arguments_[0];
  if (
    arguments_.length === 0 ||
    firstArgument === undefined ||
    ["help", "--help", "-h"].includes(firstArgument)
  ) {
    return { kind: "help" };
  }
  if (["version", "--version", "-v"].includes(firstArgument)) {
    return { kind: "version" };
  }

  const command = firstArgument;
  const options = arguments_.slice(1);
  if (command === "init") {
    rejectUnknown(options, new Set(["--dry-run", "--adapter="]));
    const adapter = readOption(options, "adapter") ?? "auto";
    if (!new Set(["auto", "generic", "codex"]).has(adapter)) {
      throw new CliError(
        "--adapter aceita auto, generic ou codex.",
        EXIT_CODES.usageOrConfiguration,
      );
    }
    return {
      kind: "init",
      dryRun: options.includes("--dry-run"),
      adapter: adapter as "auto" | "generic" | "codex",
    };
  }

  if (command === "context") {
    rejectUnknown(options, new Set(["--profile=", "--format=", "--fresh"]));
    const profile = readOption(options, "profile");
    const format = readOption(options, "format") ?? "markdown";
    if (!profile || !new Set(["apply", "audit", "assets"]).has(profile)) {
      throw new CliError(
        "Informe --profile=apply, --profile=audit ou --profile=assets.",
        EXIT_CODES.usageOrConfiguration,
      );
    }
    if (!new Set(["markdown", "json"]).has(format)) {
      throw new CliError(
        "--format aceita markdown ou json.",
        EXIT_CODES.usageOrConfiguration,
      );
    }
    return {
      kind: "context",
      profile: profile as Profile,
      format: format as OutputFormat,
      fresh: options.includes("--fresh"),
    };
  }

  if (command === "audit") {
    rejectUnknown(options, new Set(["--frozen", "--offline"]));
    return {
      kind: "audit",
      frozen: options.includes("--frozen"),
      offline: options.includes("--offline"),
    };
  }

  if (command === "logout") {
    rejectUnknown(options, new Set(["--purge-cache"]));
    return { kind: "logout", purgeCache: options.includes("--purge-cache") };
  }

  throw new CliError(
    `Comando desconhecido: ${command}.`,
    EXIT_CODES.usageOrConfiguration,
  );
}
