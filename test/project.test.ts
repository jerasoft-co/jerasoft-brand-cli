import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import packageMetadata from "../package.json" with { type: "json" };

import type { ResolvedManifest } from "../src/cache";
import {
  createDefaultConfig,
  initializeProject,
  inspectProject,
  loadProjectConfig,
  loadProjectLock,
  lockFromResolved,
  materializeAsset,
  materializeTokenPayload,
} from "../src/project";
import { distributionManifestSchema } from "../src/schemas";
import { sha256 } from "../src/security";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "jerasoft-project-test-"));
  temporaryRoots.push(root);
  return root;
}

function resolvedFixture(): ResolvedManifest {
  const asset = new TextEncoder().encode("<svg></svg>");
  const manifest = distributionManifestSchema.parse({
    schemaVersion: 1,
    protocolVersion: 1,
    releaseTag: "brand-kit-v1.0.0",
    sourceRepository: "jerasoft-co/portfolio-jerasoft",
    sourceCommit: "b".repeat(40),
    generatedAt: "2026-08-07T12:00:00.000Z",
    channel: "stable",
    minimumCliVersion: "1.0.0",
    versions: {
      bundle: "1.0.0",
      contract: "1.0.0",
      skills: "1.0.0",
      assets: "1.0.0",
    },
    payloads: [
      {
        id: "logo.jerasoft.symbol.default",
        kind: "asset",
        releaseAssetName: "asset--logo.jerasoft.symbol.default--1.0.0.svg",
        mediaType: "image/svg+xml",
        bytes: asset.byteLength,
        sha256: sha256(asset),
        version: "1.0.0",
        status: "approved",
        recommendedFilename: "jerasoft-symbol.svg",
      },
    ],
  });
  const firstPayload = manifest.payloads[0];
  if (!firstPayload) throw new Error("Fixture sem payload.");
  return {
    manifest,
    manifestSha256: "a".repeat(64),
    release: {
      id: 1,
      tagName: manifest.releaseTag,
      targetCommitish: manifest.sourceCommit,
      assets: [
        {
          id: 2,
          name: "manifest.json",
          size: 1,
          digest: `sha256:${"a".repeat(64)}`,
        },
        {
          id: 3,
          name: firstPayload.releaseAssetName,
          size: asset.byteLength,
          digest: `sha256:${sha256(asset)}`,
        },
      ],
    },
    cacheState: "fresh",
  };
}

describe("bootstrap de projeto", () => {
  test("gera configuração, lock, bloco gerenciado e skills finas", async () => {
    const root = await temporaryRoot();
    const config = createDefaultConfig();
    const lock = lockFromResolved(
      resolvedFixture(),
      new Date("2026-08-07T12:00:00.000Z"),
    );
    await initializeProject(root, config, lock);
    await initializeProject(root, config, lock);

    expect(await loadProjectConfig(root)).toEqual(config);
    expect((await loadProjectLock(root)).releaseTag).toBe("brand-kit-v1.0.0");
    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agents.match(/jerasoft-brand:start/g)).toHaveLength(1);
    expect(agents).toContain("npx @jerasoft/brand@1");
    const skill = await readFile(
      path.join(root, ".agents/skills/jerasoft-apply-brand/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("npx @jerasoft/brand@1");
    expect(skill).toContain("context --profile=apply");
    expect(skill).toContain("jerasoft-brand:managed-skill");
    expect((await inspectProject(root)).agentSkills).toEqual({
      state: "managed",
      installed: 3,
      total: 3,
    });
  });

  test("detecta projeto existente e preserva literalmente o AGENTS.md", async () => {
    const root = await temporaryRoot();
    const original = "# Regras existentes\n\nNão altere esta linha.  \n";
    await Promise.all([
      writeFile(path.join(root, "package.json"), "{}\n"),
      writeFile(path.join(root, "AGENTS.md"), original),
    ]);

    const before = await inspectProject(root);
    expect(before).toMatchObject({
      existingProject: true,
      brandInitialized: false,
      agentsFile: "existing",
      agentSkills: { state: "absent", installed: 0, total: 3 },
    });
    expect(before.signals).toContain("package.json");
    expect(before.signals).toContain("AGENTS.md");

    const config = createDefaultConfig();
    const lock = lockFromResolved(resolvedFixture());
    await initializeProject(root, config, lock);
    await initializeProject(root, config, lock);

    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agents.slice(0, original.length)).toBe(original);
    expect(agents.match(/jerasoft-brand:start/g)).toHaveLength(1);
    expect(agents).toContain("Não altere esta linha.  ");
    expect(await inspectProject(root)).toMatchObject({
      brandInitialized: true,
      brandLockPresent: true,
      agentsFile: "managed",
    });
  });

  test("normaliza configuração v1 para artefatos abertos", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, ".jerasoft"));
    await writeFile(
      path.join(root, ".jerasoft", "brand.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        protocol: 1,
        channel: "stable",
        cliRange: "^1.1.1",
        contractRange: "^1.0.0",
        updatePolicy: "compatible",
        agentAdapters: ["generic", "codex"],
        assetDirectory: "assets/brand",
      })}\n`,
    );

    expect(await loadProjectConfig(root)).toEqual({
      schemaVersion: 3,
      protocol: 1,
      channel: "stable",
      cliRange: `^${packageMetadata.version}`,
      contractRange: "^1.0.0",
      updatePolicy: "compatible",
      agentArtifacts: ["instructions", "skills"],
      assetDirectory: "assets/brand",
      appearance: { default: "light", experiences: {} },
      tokens: {
        enabled: true,
        outputDirectory: ".jerasoft/generated",
        adapters: [],
      },
    });
  });

  test("normaliza configuração v2 como perfil claro sem escrever", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, ".jerasoft"));
    const legacy = {
      schemaVersion: 2,
      protocol: 1,
      channel: "stable",
      cliRange: "^1.1.1",
      contractRange: "^1.0.0",
      updatePolicy: "compatible",
      agentArtifacts: ["instructions", "skills"],
      assetDirectory: "assets/brand",
    };
    const configPath = path.join(root, ".jerasoft", "brand.json");
    await writeFile(configPath, `${JSON.stringify(legacy)}\n`);

    expect(await loadProjectConfig(root)).toMatchObject({
      schemaVersion: 3,
      appearance: { default: "light", experiences: {} },
      tokens: { enabled: true, adapters: [] },
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(legacy);
  });

  test("reconhece e atualiza uma skill legada gerada pelo CLI", async () => {
    const root = await temporaryRoot();
    const config = createDefaultConfig();
    const lock = lockFromResolved(resolvedFixture());
    await initializeProject(root, config, lock);
    const skillPath = path.join(
      root,
      ".agents/skills/jerasoft-apply-brand/SKILL.md",
    );
    const generated = await readFile(skillPath, "utf8");
    const legacy = generated
      .replace("<!-- jerasoft-brand:managed-skill -->\n\n", "")
      .replaceAll("npx @jerasoft/brand@1", "bunx --bun @jerasoft/brand@1");
    await writeFile(skillPath, legacy);

    expect((await inspectProject(root)).agentSkills.state).toBe("managed");
    await initializeProject(root, config, lock);
    const updated = await readFile(skillPath, "utf8");
    expect(updated).toContain("jerasoft-brand:managed-skill");
    expect(updated).toContain("npx @jerasoft/brand@1");
  });

  test("não sobrescreve uma Agent Skill homônima do usuário", async () => {
    const root = await temporaryRoot();
    const skillPath = path.join(
      root,
      ".agents/skills/jerasoft-apply-brand/SKILL.md",
    );
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "# Minha skill personalizada\n");
    const config = createDefaultConfig();
    const lock = lockFromResolved(resolvedFixture());

    expect((await inspectProject(root)).agentSkills.state).toBe("conflict");
    expect(initializeProject(root, config, lock)).rejects.toThrow(
      "não é gerenciada",
    );
    expect(await readFile(skillPath, "utf8")).toBe(
      "# Minha skill personalizada\n",
    );
    expect((await inspectProject(root)).brandInitialized).toBe(false);
  });

  test("não escreve quando o bloco gerenciado de AGENTS.md está incompleto", async () => {
    const root = await temporaryRoot();
    const invalid =
      "# Regras\n\n<!-- jerasoft-brand:start -->\nbloco interrompido\n";
    await writeFile(path.join(root, "AGENTS.md"), invalid);
    const config = createDefaultConfig(["instructions"]);
    const lock = lockFromResolved(resolvedFixture());

    expect((await inspectProject(root)).agentsFile).toBe(
      "invalid-managed-block",
    );
    expect(initializeProject(root, config, lock)).rejects.toThrow(
      "bloco gerenciado",
    );
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(invalid);
    expect((await inspectProject(root)).brandInitialized).toBe(false);
  });

  test("reconhece um diretório realmente vazio", async () => {
    const root = await temporaryRoot();
    expect(await inspectProject(root)).toEqual({
      existingProject: false,
      brandInitialized: false,
      brandLockPresent: false,
      agentsFile: "absent",
      agentSkills: { state: "absent", installed: 0, total: 3 },
      signals: [],
    });
  });

  test("detecta projetos Delphi VCL e FireMonkey", async () => {
    const vclRoot = await temporaryRoot();
    const fmxRoot = await temporaryRoot();
    await Promise.all([
      writeFile(path.join(vclRoot, "Desktop.dproj"), "<Project />\n"),
      writeFile(
        path.join(fmxRoot, "Mobile.dproj"),
        "<Project><FrameworkType>FMX</FrameworkType></Project>\n",
      ),
    ]);
    expect((await inspectProject(vclRoot)).signals).toContain("Delphi VCL");
    expect((await inspectProject(fmxRoot)).signals).toContain("Delphi FMX");
  });

  test("materializa somente dentro do diretório configurado e não sobrescreve drift", async () => {
    const root = await temporaryRoot();
    const config = createDefaultConfig(["instructions"]);
    const resolved = resolvedFixture();
    const payload = resolved.manifest.payloads[0];
    if (!payload) throw new Error("Fixture sem payload.");
    const contents = new TextEncoder().encode("<svg></svg>");

    const first = await materializeAsset(
      root,
      config,
      "assets/brand/symbol.svg",
      payload,
      contents,
    );
    expect(first.changed).toBe(true);
    expect(
      (
        await materializeAsset(
          root,
          config,
          "assets/brand/symbol.svg",
          payload,
          contents,
        )
      ).changed,
    ).toBe(false);
    expect(
      materializeAsset(root, config, "public/symbol.svg", payload, contents),
    ).rejects.toThrow("dentro de assets/brand");
  });

  test("atualiza token gerenciado e recusa divergência manual", async () => {
    const root = await temporaryRoot();
    const config = createDefaultConfig(["instructions"]);
    const oldContents = new TextEncoder().encode("antigo\n");
    const newContents = new TextEncoder().encode("novo\n");
    const previousPayload = {
      id: "contract.jerasoft-tokens",
      kind: "contract" as const,
      releaseAssetName: "tokens-old.json",
      recommendedFilename: "jerasoft.tokens.json",
      mediaType: "application/design-tokens+json",
      bytes: oldContents.byteLength,
      sha256: sha256(oldContents),
      version: "1.0.0",
      status: "approved" as const,
    };
    const nextPayload = {
      ...previousPayload,
      releaseAssetName: "tokens-new.json",
      bytes: newContents.byteLength,
      sha256: sha256(newContents),
      version: "1.1.0",
    };
    const target = path.join(root, ".jerasoft/generated/jerasoft.tokens.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, oldContents);
    expect(
      (
        await materializeTokenPayload(
          root,
          config,
          nextPayload,
          newContents,
          previousPayload,
        )
      ).changed,
    ).toBe(true);
    await writeFile(target, "edição manual\n");
    expect(
      materializeTokenPayload(
        root,
        config,
        nextPayload,
        newContents,
        previousPayload,
      ),
    ).rejects.toThrow("divergiu manualmente");
  });
});
