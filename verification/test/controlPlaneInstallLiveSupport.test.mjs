import { strict as assert } from "node:assert";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { runFacade } from "../scripts/control-plane-install-live-support.mjs";
import {
  controlPlaneFacadeEnvironment,
  createOperatorFixture
} from "../scripts/control-plane-install-live-fixture.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("control-plane live facade support", () => {
  it("uses a private distinct registrar only for the selected candidate config and restores idle bytes", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-live-candidate-config-"));
    temporaryRoots.push(root);
    const operatorRoot = join(root, "operator");
    await mkdir(operatorRoot, { mode: 0o700 });
    const configPath = join(operatorRoot, "install.json");
    const fixture = await createOperatorFixture({
      operatorRoot,
      configPath,
      deploymentId: "candidate-config-test",
      ports: { nativeGit: 18081, ordinaryCi: 18082 }
    });
    const idleBytes = await readFile(fixture.sources.nativeGit);
    const images = {
      nativeGit: `registry.example/native@sha256:${"a".repeat(64)}`,
      ordinaryCi: `registry.example/ordinary@sha256:${"b".repeat(64)}`
    };

    // When
    await fixture.writeCandidateConfig(images);

    // Then
    const candidateBytes = await readFile(fixture.sources.nativeGit);
    const candidate = JSON.parse(candidateBytes.toString("utf8"));
    const install = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(candidate.projectRegistrars.length, 1);
    assert.equal(candidate.projectRegistrars[0].password, fixture.candidateRegistrarCredential);
    assert.equal(new Set([...Object.values(fixture.credentials), fixture.candidateRegistrarCredential]).size, 8);
    assert.equal((await lstat(fixture.sources.nativeGit)).mode & 0o777, 0o600);
    assert.equal(install.nativeGit.image, images.nativeGit);
    assert.equal(install.ordinaryCi.image, images.ordinaryCi);
    assert.equal(JSON.stringify(install).includes(fixture.candidateRegistrarCredential), false);
    assert.equal(JSON.stringify(controlPlaneFacadeEnvironment({
      environment: {}, home: root, path: "/usr/bin", stateHome: root, lifecycleStateRoot: root
    })).includes(fixture.candidateRegistrarCredential), false);

    await fixture.restoreIdleConfig();
    assert.deepEqual(await readFile(fixture.sources.nativeGit), idleBytes);
    assert.equal((await lstat(fixture.sources.nativeGit)).mode & 0o777, 0o600);
  });

  it("pins facade HOME, installer state, lifecycle state, and trusted PATH independently", () => {
    // Given
    const environment = { DOCKER_HOST: "unix:///run/docker.sock", HOME: "/host/home" };

    // When
    const actual = controlPlaneFacadeEnvironment({
      environment,
      home: "/fixture/home",
      path: "/usr/local/bin:/usr/bin",
      stateHome: "/fixture/installer-state",
      lifecycleStateRoot: "/fixture/lifecycle-state"
    });

    // Then
    assert.deepEqual(actual, {
      DOCKER_HOST: "unix:///run/docker.sock",
      HOME: "/fixture/home",
      PATH: "/usr/local/bin:/usr/bin",
      XDG_STATE_HOME: "/fixture/installer-state",
      DIM_STATE_ROOT: "/fixture/lifecycle-state"
    });
  });

  it("returns a denied facade status and diagnostics without converting it to success", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-live-facade-support-"));
    temporaryRoots.push(root);
    const executable = join(root, "dim");
    await writeFile(executable, "#!/bin/sh\nprintf 'denied output\\n'\nprintf 'denied diagnostic\\n' >&2\nexit 23\n", { mode: 0o700 });

    // When
    const result = await runFacade({
      executable,
      configPath: join(root, "install.json"),
      cwd: root,
      environment: process.env
    });

    // Then
    assert.deepEqual(result, { exitCode: 23, stdout: "denied output\n", stderr: "denied diagnostic\n" });
  });
});
