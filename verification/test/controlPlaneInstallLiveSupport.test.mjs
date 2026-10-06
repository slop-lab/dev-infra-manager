import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { runFacade } from "../scripts/control-plane-install-live-support.mjs";
import { controlPlaneFacadeEnvironment } from "../scripts/control-plane-install-live-fixture.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("control-plane live facade support", () => {
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
