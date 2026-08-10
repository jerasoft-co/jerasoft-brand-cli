export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface TerminalState {
  interactive: boolean;
}

export const defaultIo: CliIo = {
  stdout: console.log,
  stderr: console.error,
};

export const defaultTerminalState: TerminalState = {
  interactive: process.stdin.isTTY && process.stdout.isTTY,
};
