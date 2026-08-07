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

export function redactSecrets(message: string) {
  return message
    .replace(
      /\b(?:ghu|ghr|ghp|gho|ghs|github_pat)_[A-Za-z0-9_-]+\b/g,
      "[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+\b/gi, "Bearer [REDACTED]")
    .replace(
      /([?&](?:token|sig|signature|x-amz-signature)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );
}

export function safeErrorMessage(error: unknown) {
  if (error instanceof CliError) return redactSecrets(error.message);
  return "Não foi possível concluir a operação solicitada.";
}
