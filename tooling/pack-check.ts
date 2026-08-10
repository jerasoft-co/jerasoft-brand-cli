import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

interface PackResult {
  filename: string;
  files: { path: string }[];
}

const repositoryRoot = process.cwd();
const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
const parsed = JSON.parse(output) as PackResult[] | Record<string, PackResult>;
const packs = Array.isArray(parsed) ? parsed : Object.values(parsed);
if (packs.length !== 1 || !packs[0]) {
  throw new Error("O npm não produziu exatamente um tarball.");
}

const pack = packs[0];
const expectedFiles = ["README.md", "dist/cli.js", "package.json"];
const actualFiles = pack.files.map((file) => file.path).sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    `O tarball contém uma lista inesperada de arquivos: ${actualFiles.join(", ")}.`,
  );
}

const archivePath = path.join(repositoryRoot, pack.filename);
try {
  const archiveEntries = execFileSync("tar", ["-tzf", archivePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .sort();
  const expectedEntries = expectedFiles.map((file) => `package/${file}`).sort();
  if (JSON.stringify(archiveEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error("A allowlist interna do tarball diverge do pacote npm.");
  }

  const publicContents = await Promise.all(
    expectedFiles.map((file) =>
      readFile(path.join(repositoryRoot, file), "utf8"),
    ),
  );
  const forbiddenPatterns = [
    /github_pat_[A-Za-z0-9_]+/,
    /gh[pousr]_[A-Za-z0-9]+/,
    /brand\/contracts\//,
    /brand\/skills\//,
    /asset-catalog\.json/,
    /BEGIN PRIVATE KEY/,
  ];
  for (const pattern of forbiddenPatterns) {
    if (publicContents.some((contents) => pattern.test(contents))) {
      throw new Error(
        "O tarball contém conteúdo incompatível com a fronteira pública.",
      );
    }
  }
} finally {
  await rm(archivePath, { force: true });
}

console.info("Tarball público validado com 3 arquivos permitidos.");
