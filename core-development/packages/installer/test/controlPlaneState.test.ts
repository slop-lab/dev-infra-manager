import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlPlaneConfig } from "../../../../core/packages/installer/src/controlPlaneConfig.js";
import { acquireControlPlaneStateLock, type ControlPlaneStateLock } from "../../../../core/packages/installer/src/controlPlaneLock.js";
import { completeControlPlaneSourcePreflight, readControlPlaneSources } from "../../../../core/packages/installer/src/controlPlaneSources.js";
import {
  assertControlPlaneStagedSources,
  discardControlPlaneStaging,
  controlPlaneGenerationId,
  finalizeControlPlaneGeneration,
  isControlPlaneInstalledInput,
  completeControlPlaneInstalledState,
  publishControlPlaneInstalledState,
  readControlPlaneInstalledState,
  stageControlPlaneSources
} from "../../../../core/packages/installer/src/controlPlaneState.js";
import { controlPlaneSecrets, writeControlPlaneFixture } from "./controlPlaneFixture.js";

const temporaryDirectories: string[] = [];
const stateLocks: ControlPlaneStateLock[] = [];

afterEach(async () => {
  await Promise.all(stateLocks.splice(0).map((lock) => lock.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("control-plane installed state", () => {
  it("publishes and rereads an immutable generation with exact record, bytes, ownership, and modes", async () => {
    // Given: validated source bytes staged before activation-token allocation.
    const input = await fixture();
    const beforeTokens = await stageControlPlaneSources({ lock: input.lock, sources: input.sources, prior: undefined });
    expect((await lstat(beforeTokens.path)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(beforeTokens.path)) {
      const metadata = await lstat(join(beforeTokens.path, name));
      const effectiveUid = process.geteuid?.();
      if (effectiveUid === undefined) throw new Error("test requires a Linux user identity");
      expect(metadata.uid).toBe(effectiveUid);
      expect(metadata.mode & 0o777).toBe(0o444);
    }
    const completed = completeControlPlaneSourcePreflight(input.sources, activationBytes());

    // When: the generation and guarded installed record are published.
    const candidate = await finalizeControlPlaneGeneration({ lock: input.lock, staging: beforeTokens, config: input.config, sources: completed });
    expect(candidate.generationId).toBe("f3d0fb420a71a8fb3bb3bbfc9f82df7e962841ed8d06fddc84909ff5b0ab70b8");
    await publishControlPlaneInstalledState(input.lock, candidate, { volumesEstablished: true });
    await expect(readControlPlaneInstalledState(input.lock)).rejects.toThrow(/incomplete transaction/);
    await completeControlPlaneInstalledState(input.lock, candidate);

    // Then: strict reread verifies exact bytes and metadata without serializing credentials.
    const installed = await readControlPlaneInstalledState(input.lock);
    expect(installed).toBeDefined();
    if (installed === undefined) throw new Error("installed state is missing");
    expect(installed.record.nativeGitImage).toBe(input.config.nativeGit.image);
    expect(installed.record.ordinaryCiImage).toBe(input.config.ordinaryCi.image);
    expect(installed.record.nativeGitPublish).toEqual(input.config.nativeGit.publish);
    expect(installed.record.ordinaryCiPublish).toEqual(input.config.ordinaryCi.publish);
    expect(installed.snapshots.nativeGit.config.equals(input.sources.nativeGit.config.bytes)).toBe(true);
    expect(installed.snapshots.ordinaryCi.readinessToken.equals(input.sources.ordinaryCi.readinessToken.bytes)).toBe(true);
    expect((await lstat(input.root)).mode & 0o777).toBe(0o700);
    expect((await lstat(installed.generationPath)).mode & 0o777).toBe(0o700);
    const generationFiles = await readdir(installed.generationPath);
    expect(generationFiles).toHaveLength(6);
    for (const name of generationFiles) {
      expect((await lstat(join(installed.generationPath, name))).mode & 0o777).toBe(0o444);
    }
    expect((await lstat(join(input.root, "install.json"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(input.root, "compose.yml"))).mode & 0o777).toBe(0o600);
    const stateText = `${await readFile(join(input.root, "install.json"), "utf8")}\n${await readFile(join(input.root, "compose.yml"), "utf8")}`;
    for (const secret of completed.allSecretValues) expect(stateText).not.toContain(secret);
  });

  it("rejects mode-tampered immutable staged sources before image probes", async () => {
    // Given: exact source snapshots whose mode is changed after staging.
    const input = await fixture();
    const staging = await stageControlPlaneSources({ lock: input.lock, sources: input.sources, prior: undefined });
    const stagedConfig = join(staging.path, "native-git.json");
    await chmod(stagedConfig, 0o600);
    const before = await treeDigest(input.root);

    // When: pre-probe staging validation reads the staged source set.
    const validation = assertControlPlaneStagedSources({ lock: input.lock, staging, sources: input.sources });

    // Then: invalid staging is refused before Docker or generation mutation.
    await expect(validation).rejects.toThrow(/mode/);
    expect(await readdir(join(input.root, "generations"))).toEqual([]);
    expect(await treeDigest(input.root)).toBe(before);
    await chmod(stagedConfig, 0o444);
    await discardControlPlaneStaging(input.lock, staging);
  });

  it("compares a no-op without allocating tokens or rewriting persistent state", async () => {
    // Given: one valid installed generation and a fresh read of identical operator bytes.
    const input = await fixture();
    await install(input);
    const installed = await readControlPlaneInstalledState(input.lock);
    if (installed === undefined) throw new Error("installed state is missing");
    const before = await treeDigest(input.root);
    const staging = await stageControlPlaneSources({ lock: input.lock, sources: input.sources, prior: installed });
    let allocations = 0;

    // When: the pure no-op comparison runs before the token allocator seam.
    const matches = isControlPlaneInstalledInput(installed, input.config, input.sources);
    if (!matches) {
      allocations += 1;
      completeControlPlaneSourcePreflight(input.sources, activationBytes());
    } else {
      await discardControlPlaneStaging(input.lock, staging);
    }

    // Then: no token was allocated and every persistent byte remains unchanged.
    expect(matches).toBe(true);
    expect(isControlPlaneInstalledInput(installed, {
      ...input.config,
      nativeGit: { ...input.config.nativeGit, publish: { ...input.config.nativeGit.publish, port: 7543 } },
      ordinaryCi: { ...input.config.ordinaryCi, publish: { ...input.config.ordinaryCi.publish, port: 7510 } }
    }, input.sources)).toBe(false);
    expect(allocations).toBe(0);
    expect(await treeDigest(input.root)).toBe(before);
  });

  it("rejects Compose publication changes even when its recorded digest is also replaced", async () => {
    // Given: a valid installation whose Compose publication and matching digest are both tampered.
    const input = await fixture();
    await install(input);
    const composePath = join(input.root, "compose.yml");
    const installPath = join(input.root, "install.json");
    const compose = (await readFile(composePath, "utf8")).replace('published: "7443"', 'published: "7543"');
    const record = JSON.parse(await readFile(installPath, "utf8"));
    await writeFile(composePath, compose, { mode: 0o600 });
    await writeFile(installPath, `${JSON.stringify({ ...record, composeSha256: `sha256:${createHash("sha256").update(compose).digest("hex")}` }, null, 2)}\n`, { mode: 0o600 });
    const before = await treeDigest(input.root);

    // When: state validation reconstructs the expected deterministic Compose bytes.
    const reading = readControlPlaneInstalledState(input.lock);

    // Then: the record and Compose mismatch is denied without changing state.
    await expect(reading).rejects.toThrow(/Compose/);
    expect(await treeDigest(input.root)).toBe(before);
  });

  it("rejects the previous schema-1 draft that omitted published endpoints", async () => {
    // Given: installed bytes in the unpublished schema-1 draft shape.
    const input = await fixture();
    await install(input);
    const installPath = join(input.root, "install.json");
    const draft = (await readFile(installPath, "utf8")).replace(
      /  "nativeGitPublish": \{[\s\S]*?  \},\n  "ordinaryCiPublish": \{[\s\S]*?  \},\n/,
      ""
    );
    await writeFile(installPath, draft, { mode: 0o600 });
    const before = await treeDigest(input.root);

    // When: exact schema validation reads the obsolete record.
    const reading = readControlPlaneInstalledState(input.lock);

    // Then: it rejects without migration, aliasing, Docker, or byte changes.
    await expect(reading).rejects.toThrow(/schema/);
    expect(await treeDigest(input.root)).toBe(before);
  });

  it("fails closed on modified, missing, symbolic-link, extra, partial, conflicting, and schema-less state", async () => {
    // Given: independently installed valid states for each corrupting mutation.
    const corruptions: readonly ((input: Awaited<ReturnType<typeof fixture>>) => Promise<void>)[] = [
      async ({ root }) => writeFile(join(root, "compose.yml"), "modified\n"),
      async ({ root }) => rm(join(root, "compose.yml")),
      async ({ root }) => { await rm(join(root, "compose.yml")); await symlink("install.json", join(root, "compose.yml")); },
      async ({ root }) => writeFile(join(root, "extra"), "x"),
      async ({ root }) => chmod(join(root, "compose.yml"), 0o644),
      async ({ root }) => {
        await mkdir(join(root, ".staging-interrupted"), { mode: 0o700 });
        await writeFile(join(root, ".staging-interrupted", "native-git.json"), "partial", { mode: 0o600 });
        await writeFile(join(root, "transaction.json"), "{}\n", { mode: 0o600 });
      },
      async ({ root }) => writeFile(join(root, "install.json"), "{}\n", { mode: 0o600 }),
      async ({ root }) => {
        const record = JSON.parse(await readFile(join(root, "install.json"), "utf8"));
        await writeFile(join(root, "install.json"), `${JSON.stringify({ ...record, generationId: "f".repeat(64) })}\n`);
        await chmod(join(root, "install.json"), 0o600);
      }
    ];

    for (const corrupt of corruptions) {
      const input = await fixture();
      await install(input);
      await corrupt(input);
      const before = await treeDigest(input.root);

      // When: strict installed-state validation observes the disputed artifact.
      const reading = readControlPlaneInstalledState(input.lock);

      // Then: it rejects without changing a byte or invoking Docker.
      await expect(reading).rejects.toThrow();
      expect(await treeDigest(input.root)).toBe(before);
    }
  });

  it("rejects a conflicting generation instead of adopting or rewriting it", async () => {
    // Given: a staged candidate whose computed generation path already exists.
    const input = await fixture();
    const completed = completeControlPlaneSourcePreflight(input.sources, activationBytes());
    const staging = await stageControlPlaneSources({ lock: input.lock, sources: input.sources, prior: undefined });
    const generationId = controlPlaneGenerationId(input.config, completed);
    await mkdir(join(input.root, "generations", generationId), { mode: 0o700 });
    const before = await treeDigest(input.root);

    // When/Then: the same generation ID conflicts and neither candidate is adopted.
    await expect(finalizeControlPlaneGeneration({ lock: input.lock, staging, config: input.config, sources: completed })).rejects.toThrow(/generation/);
    expect(await treeDigest(input.root)).toBe(before);
    await discardControlPlaneStaging(input.lock, staging);
  });

  it("retains the previous immutable generation after publishing an update", async () => {
    // Given: a valid installed generation and a changed descriptor-verified image reference.
    const input = await fixture();
    await install(input);
    const prior = await readControlPlaneInstalledState(input.lock);
    if (prior === undefined) throw new Error("installed state is missing");
    const changed = parseControlPlaneConfig({
      ...input.config,
      nativeGit: { ...input.config.nativeGit, image: `registry.example/dim/native-git@sha256:${"c".repeat(64)}` }
    }, ["127.0.0.1"]);
    const staging = await stageControlPlaneSources({ lock: input.lock, sources: input.sources, prior });
    const candidate = await finalizeControlPlaneGeneration({
      lock: input.lock,
      staging,
      config: changed,
      sources: completeControlPlaneSourcePreflight(input.sources, {
        nativeGit: Buffer.from(`${Buffer.alloc(32, 12).toString("base64url")}\n`),
        ordinaryCi: Buffer.from(`${Buffer.alloc(32, 13).toString("base64url")}\n`)
      })
    });

    // When: the update record is published after volumes are explicitly established.
    await publishControlPlaneInstalledState(input.lock, candidate, { volumesEstablished: true });
    await completeControlPlaneInstalledState(input.lock, candidate);

    // Then: the new record is current and both immutable generations remain available.
    const current = await readControlPlaneInstalledState(input.lock);
    expect(current?.record.generationId).toBe(candidate.generationId);
    expect((await readdir(join(input.root, "generations"))).sort()).toEqual([
      prior.record.generationId,
      candidate.generationId
    ].sort());
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dim-control-plane-state-"));
  temporaryDirectories.push(directory);
  const fixtureValue = await writeControlPlaneFixture(join(directory, "operator"));
  const config = parseControlPlaneConfig(fixtureValue.config, ["127.0.0.1"]);
  const root = join(directory, "state");
  const lock = await acquireControlPlaneStateLock(root);
  stateLocks.push(lock);
  return { root, lock, config, sources: await readControlPlaneSources(config) };
}

function activationBytes() {
  return {
    nativeGit: Buffer.from(`${controlPlaneSecrets.nativeActivation}\n`),
    ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
  } as const;
}

async function install(input: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const staging = await stageControlPlaneSources({ lock: input.lock, sources: input.sources, prior: undefined });
  const candidate = await finalizeControlPlaneGeneration({
    lock: input.lock,
    staging,
    config: input.config,
    sources: completeControlPlaneSourcePreflight(input.sources, activationBytes())
  });
  await publishControlPlaneInstalledState(input.lock, candidate, { volumesEstablished: true });
  await completeControlPlaneInstalledState(input.lock, candidate);
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string, relative: string): Promise<void> {
    const metadata = await lstat(path);
    hash.update(`${relative}\0${metadata.mode & 0o777}\0${metadata.isSymbolicLink() ? "l" : metadata.isDirectory() ? "d" : "f"}\0`);
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`);
      return;
    }
    hash.update(await readFile(path));
  }
  await visit(root, ".");
  return hash.digest("hex");
}
