import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { EXIT_CODES } from "./constants";
import { CliError } from "./errors";

export function sha256(contents: Uint8Array | string) {
  return createHash("sha256").update(contents).digest("hex");
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function pathExists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function ensureSafeDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const parent = path.dirname(resolved);
  if (parent === resolved) return;

  try {
    const entry = await lstat(resolved);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new CliError(
        `O diretório seguro não pode ser link simbólico nem arquivo: ${resolved}.`,
        EXIT_CODES.integrity,
      );
    }
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  await ensureSafeDirectory(parent);
  try {
    await mkdir(resolved, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const created = await lstat(resolved);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new CliError(
      `Não foi possível criar um diretório seguro em ${resolved}.`,
      EXIT_CODES.integrity,
    );
  }
}

export async function readRegularFile(filePath: string) {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new CliError(
      `O caminho esperado não é um arquivo regular: ${filePath}.`,
      EXIT_CODES.integrity,
    );
  }
  return readFile(filePath);
}

export async function atomicWriteFile(
  filePath: string,
  contents: Uint8Array | string,
  mode = 0o600,
) {
  const resolved = path.resolve(filePath);
  await ensureSafeDirectory(path.dirname(resolved));

  try {
    const current = await lstat(resolved);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new CliError(
        `O destino não pode ser substituído com segurança: ${resolved}.`,
        EXIT_CODES.integrity,
      );
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, resolved);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function verifyFile(
  filePath: string,
  expectedBytes: number,
  expectedSha256: string,
) {
  const contents = await readRegularFile(filePath);
  if (contents?.byteLength !== expectedBytes) return null;
  if (sha256(contents) !== expectedSha256) return null;
  return contents;
}

export function resolveInside(root: string, requestedPath: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, requestedPath);
  const relation = path.relative(resolvedRoot, resolvedPath);
  if (
    relation === "" ||
    relation.startsWith("..") ||
    path.isAbsolute(relation)
  ) {
    throw new CliError(
      "O destino precisa ser um arquivo dentro do projeto.",
      EXIT_CODES.usageOrConfiguration,
    );
  }
  return resolvedPath;
}

export async function assertSafeParentChain(root: string, target: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relation = path.relative(resolvedRoot, resolvedTarget);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new CliError(
      "O caminho solicitado escapa do diretório permitido.",
      EXIT_CODES.integrity,
    );
  }

  let current = resolvedRoot;
  for (const segment of relation.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new CliError(
          `O caminho contém um segmento inseguro: ${current}.`,
          EXIT_CODES.integrity,
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      break;
    }
  }
}
