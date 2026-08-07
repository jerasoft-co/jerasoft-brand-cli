import { EXIT_CODES } from "./constants";

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function safeErrorMessage(error: unknown) {
  if (error instanceof CliError) return error.message;
  return "Não foi possível concluir a operação solicitada.";
}
