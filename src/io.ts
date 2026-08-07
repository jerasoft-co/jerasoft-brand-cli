export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export const defaultIo: CliIo = {
  stdout: console.log,
  stderr: console.error,
};
