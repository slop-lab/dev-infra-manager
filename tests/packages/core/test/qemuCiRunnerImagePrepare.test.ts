import { watch } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QEMU_CI_NO_HOOK_DIGEST } from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import {
  commonImagePath,
  createPrepareHarness,
  projectImagePath,
  readToolLog
} from "./qemuCiRunnerImagePrepareHarness.js";
import type { PrepareHarness } from "./qemuCiRunnerImagePrepareHarness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness(): Promise<PrepareHarness> {
  const created = await createPrepareHarness();
  cleanups.push(created.cleanup);
  return created;
}

describe("QEMU CI image preparation", () => {
  it("reuses one common build while publishing distinct concurrent Project images", async () => {
    // Given: two conceptual Projects with the same common key and distinct Project keys.
    const fixture = await harness();
    const firstKey = "b".repeat(64);
    const secondKey = "c".repeat(64);

    const firstPreparation = fixture.run(firstKey, { FAKE_HOLD_COMMON: firstKey });
    await waitForFile(join(fixture.root, `common-started-${firstKey}`));

    // When: the second preparation reaches the common lock while the first build holds it.
    const secondPreparation = fixture.run(secondKey);
    await waitForFile(join(fixture.root, `common-lock-ready-${secondKey}`));
    await releaseBarrier(join(fixture.root, `release-common-${firstKey}`));
    const [first, second] = await Promise.all([firstPreparation, secondPreparation]);

    // Then: common Packer runs once, each Project Packer runs once, and exact final paths are printed.
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(new Set([first.stdout, second.stdout])).toEqual(new Set([
      `${projectImagePath(fixture, firstKey)}\n`,
      `${projectImagePath(fixture, secondKey)}\n`
    ]));
    const log = await readToolLog(fixture);
    expect(log.filter((line) => line.startsWith("packer build") && /common\.pkr\.hcl$/.test(line))).toHaveLength(1);
    expect(log.filter((line) => line.startsWith("packer build") && /project\.pkr\.hcl$/.test(line))).toHaveLength(2);
  });

  it("generates no build identities on immutable cache hits", async () => {
    // Given: a successfully published common and Project image.
    const fixture = await harness();
    const projectKey = "d".repeat(64);
    expect((await fixture.run(projectKey)).code).toBe(0);
    const initialLog = await readToolLog(fixture);

    // When: the same complete keys are prepared again.
    const cached = await fixture.run(projectKey);

    // Then: validation reuses both artifacts without Packer or SSH key generation.
    expect(cached).toMatchObject({ code: 0, stdout: `${projectImagePath(fixture, projectKey)}\n`, stderr: "" });
    const additionalLog = (await readToolLog(fixture)).slice(initialLog.length);
    expect(additionalLog.some((line) => line.startsWith("packer "))).toBe(false);
    expect(additionalLog.some((line) => line.startsWith("ssh-keygen "))).toBe(false);
  });

  it("publishes neither artifact and removes build keys when common Packer fails", async () => {
    // Given: a fresh cache and a failing common Packer process.
    const fixture = await harness();
    const projectKey = "e".repeat(64);

    // When: image preparation fails in the common stage.
    const result = await fixture.run(projectKey, { FAKE_PACKER_FAIL: "common" });

    // Then: no immutable destination or private build key remains.
    expect(result.code).not.toBe(0);
    await expect(stat(commonImagePath(fixture))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(projectImagePath(fixture, projectKey))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readToolLog(fixture)).filter((line) => line.startsWith("ssh-keygen "))).toHaveLength(1);
    await expectNoBuildIdentity(fixture);
  });

  it("publishes nothing when qemu-img rejects the common artifact", async () => {
    // Given: common Packer succeeds but qemu-img check rejects its output.
    const fixture = await harness();
    const projectKey = "0".repeat(64);

    // When: preparation checks the staged common image.
    const result = await fixture.run(projectKey, { FAKE_QEMU_IMG_FAIL_CHECK: "runner-common.qcow2" });

    // Then: neither final image directory is published.
    expect(result.code).not.toBe(0);
    await expect(stat(commonImagePath(fixture))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(projectImagePath(fixture, projectKey))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes common first but no Project artifact when Project validation fails", async () => {
    // Given: a Project Packer result with a malformed backing chain.
    const fixture = await harness();
    const projectKey = "f".repeat(64);

    // When: preparation validates the Project output.
    const result = await fixture.run(projectKey, { FAKE_PROJECT_CHAIN: "invalid" });

    // Then: the immutable common survives while no Project destination is published.
    expect(result.code).not.toBe(0);
    await expect(stat(commonImagePath(fixture))).resolves.toBeDefined();
    await expect(stat(projectImagePath(fixture, projectKey))).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoBuildIdentity(fixture);
  });

  it("keeps the common artifact but publishes no Project directory when Project Packer fails", async () => {
    // Given: common construction succeeds and Project Packer fails.
    const fixture = await harness();
    const projectKey = "6".repeat(64);

    // When: preparation reaches the Project build stage.
    const result = await fixture.run(projectKey, { FAKE_PACKER_FAIL: "project" });

    // Then: common publication is complete and Project publication is absent.
    expect(result.code).not.toBe(0);
    await expect(stat(commonImagePath(fixture))).resolves.toBeDefined();
    await expect(stat(projectImagePath(fixture, projectKey))).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoBuildIdentity(fixture);
  });

  it("fails closed without replacing a malformed immutable destination", async () => {
    // Given: an occupied common key directory containing malformed bytes only.
    const fixture = await harness();
    const projectKey = "1".repeat(64);
    const commonDirectory = join(fixture.commonRoot, "images", "a".repeat(64));
    await mkdir(commonDirectory, { recursive: true });
    await writeFile(join(commonDirectory, "runner-common.qcow2"), "occupied");

    // When: preparation encounters that immutable destination.
    const result = await fixture.run(projectKey);

    // Then: it fails without Packer, replacement, or Project publication.
    expect(result.code).not.toBe(0);
    await expect(readFile(join(commonDirectory, "runner-common.qcow2"), "utf8")).resolves.toBe("occupied");
    expect((await readToolLog(fixture)).some((line) => line.startsWith("packer "))).toBe(false);
    await expect(stat(projectImagePath(fixture, projectKey))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("normalizes only a staging Project child when Packer resolves the common image through cache", async () => {
    // Given: Packer records a cache-resolved path for the common backing file.
    const fixture = await harness();
    const projectKey = "2".repeat(64);
    const cachedBacking = join(fixture.root, "packer-cache", "resolved.qcow2");

    // When: the Project artifact is prepared.
    const result = await fixture.run(projectKey, { FAKE_PACKER_BACKING: cachedBacking });

    // Then: one unsafe rebase targets staging and the published chain names the immutable common path.
    expect(result.code).toBe(0);
    const rebases = (await readToolLog(fixture)).filter((line) => line.startsWith("qemu-img rebase"));
    expect(rebases).toHaveLength(1);
    expect(rebases[0]).toContain("/staging/");
    expect(rebases[0]).toContain(commonImagePath(fixture));
    expect(rebases[0]).not.toContain(projectImagePath(fixture, projectKey));
    await expect(readFile(`${projectImagePath(fixture, projectKey)}.backing`, "utf8")).resolves.toBe(`${commonImagePath(fixture)}\n`);
  });

  it("does not rebase an already correct Project chain", async () => {
    // Given: Packer records the immutable common image as its backing file.
    const fixture = await harness();
    const projectKey = "3".repeat(64);

    // When: preparation validates and publishes the Project output.
    const result = await fixture.run(projectKey);

    // Then: no rebase or commit operation touches staging or publication.
    expect(result.code).toBe(0);
    const log = await readToolLog(fixture);
    expect(log.some((line) => line.startsWith("qemu-img rebase"))).toBe(false);
    expect(log.some((line) => line.includes(" commit "))).toBe(false);
  });

  it("writes non-secret manifests and keeps common and Project build keys separate", async () => {
    // Given: sentinel coordinator, runner, job, token, and hook-body values in the process environment.
    const fixture = await harness();
    const projectKey = "4".repeat(64);
    const sentinels = { GITEA_INSTANCE_URL: "secret-url", GITEA_RUNNER_REGISTRATION_TOKEN: "secret-token", GITEA_RUNNER_NAME: "secret-runner", DIM_QEMU_JOB_DATA: "secret-job", DIM_QEMU_HOOK_BODY: "secret-hook" };

    // When: both image stages publish their manifests.
    const result = await fixture.run(projectKey, sentinels);

    // Then: manifests contain only immutable construction data and key files used distinct staging paths.
    expect(result.code).toBe(0);
    const manifests = await Promise.all([
      readFile(join(fixture.commonRoot, "images", "a".repeat(64), "manifest.json"), "utf8"),
      readFile(join(fixture.projectRoot, "images", projectKey, "manifest.json"), "utf8")
    ]);
    expect(JSON.parse(manifests[1])).toMatchObject({
      hookKind: "absent",
      hookDigest: QEMU_CI_NO_HOOK_DIGEST,
      hookSourceRef: "refs/heads/main",
      hookSourceCommit: "f".repeat(40)
    });
    for (const manifest of manifests) {
      for (const sentinel of Object.values(sentinels)) expect(manifest).not.toContain(sentinel);
    }
    const keyCommands = (await readToolLog(fixture)).filter((line) => line.startsWith("ssh-keygen "));
    expect(keyCommands).toHaveLength(2);
    expect(keyCommands[0]).not.toBe(keyCommands[1]);
    await expectNoBuildIdentity(fixture);
    const packerEnvironment = await readFile(join(fixture.root, "packer-env.log"), "utf8");
    for (const sentinel of Object.values(sentinels)) expect(packerEnvironment).not.toContain(sentinel);
  });

  it("rejects malformed keys and hook identities before invoking tools", async () => {
    // Given: malformed uppercase keys and an absent hook with the wrong digest.
    const fixture = await harness();

    // When: each untrusted preparation input crosses the script boundary.
    const malformedKey = await fixture.run("B".repeat(64));
    const malformedHook = await fixture.run("5".repeat(64), { DIM_QEMU_CI_PROJECT_HOOK_DIGEST: "6".repeat(64) });

    // Then: both fail before external image or key tools run.
    expect(malformedKey.code).not.toBe(0);
    expect(malformedHook.code).not.toBe(0);
    expect(await readToolLog(fixture)).toEqual([]);
  });

  it("keeps final directories invisible while a build is incomplete", async () => {
    // Given: common Packer is paused after its unique staging directory exists.
    const fixture = await harness();
    const projectKey = "7".repeat(64);
    const preparation = fixture.run(projectKey, { FAKE_HOLD_COMMON: projectKey });
    await waitForFile(join(fixture.root, `common-started-${projectKey}`));

    // When: a reader checks both final image destinations during the build.
    const visible = await Promise.all([pathExists(commonImagePath(fixture)), pathExists(projectImagePath(fixture, projectKey))]);

    // Then: neither partial final directory is observable before atomic publication.
    expect(visible).toEqual([false, false]);
    await releaseBarrier(join(fixture.root, `release-common-${projectKey}`));
    expect((await preparation).code).toBe(0);
  });

  it("releases the common lock before waiting for a distinct Project lock", async () => {
    // Given: one Project build is paused while holding only its Project-key lock.
    const fixture = await harness();
    const blockedKey = "8".repeat(64);
    const otherKey = "9".repeat(64);
    const blocked = fixture.run(blockedKey, { FAKE_HOLD_PROJECT_KEY: blockedKey });
    await waitForFile(join(fixture.root, `project-started-${blockedKey}`));

    // When: a distinct Project reaches its Project build while the first remains blocked.
    const otherPreparation = fixture.run(otherKey);
    await waitForFile(join(fixture.root, `common-lock-ready-${otherKey}`));
    await waitForFile(join(fixture.root, `project-started-${otherKey}`));

    // Then: it completes without waiting for the first Project lock.
    const other = await otherPreparation;
    expect(other.code).toBe(0);
    await releaseBarrier(join(fixture.root, `release-project-${blockedKey}`));
    expect((await blocked).code).toBe(0);
  });
});

async function expectNoBuildIdentity(fixture: PrepareHarness): Promise<void> {
  const process = await import("node:child_process");
  const result = process.spawnSync("sh", ["-c", `test -z "$(find '${fixture.root}' -type f \\( -name id -o -name id.pub \\) -print -quit)"`]);
  expect(result.status).toBe(0);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function waitForFile(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for fake tool marker ${path}`)), 4_000);
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename === basename(path)) finish();
    });
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      watcher.close();
      if (error === undefined) resolve();
      else reject(error);
    };
    watcher.on("error", finish);
    void pathExists(path).then((exists) => { if (exists) finish(); }, reject);
  });
}

async function releaseBarrier(path: string): Promise<void> {
  await writeFile(path, "release\n", { signal: AbortSignal.timeout(4_000) });
}
