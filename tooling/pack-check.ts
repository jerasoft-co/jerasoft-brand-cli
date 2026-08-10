import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = process.cwd();
const expectedFiles = ["README.md", "dist/cli.js", "package.json"];
const packDirectory = await mkdtemp(
  path.join(tmpdir(), "jerasoft-pack-check-"),
);
const archivePath = path.join(packDirectory, "package.tgz");
try {
  execFileSync(
    process.execPath,
    ["pm", "pack", "--filename", archivePath, "--ignore-scripts", "--quiet"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
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
  await rm(packDirectory, { recursive: true, force: true });
}

console.info("Tarball público validado com 3 arquivos permitidos.");
