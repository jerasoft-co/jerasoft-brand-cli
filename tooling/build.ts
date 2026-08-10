import { chmod, rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = process.cwd();
const outputDirectory = path.join(repositoryRoot, "dist");
await rm(outputDirectory, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [path.join(repositoryRoot, "src/cli.ts")],
  outdir: outputDirectory,
  naming: "cli.js",
  target: "node",
  format: "esm",
  external: ["@napi-rs/keyring"],
  minify: false,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Não foi possível gerar o executável público.");
}

await chmod(path.join(outputDirectory, "cli.js"), 0o755);
console.info("Executável público gerado em dist/cli.js.");
