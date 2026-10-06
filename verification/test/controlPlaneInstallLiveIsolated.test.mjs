import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { runIsolatedFacadeNoOp } from "../scripts/control-plane-install-live-isolated.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("isolated control-plane live no-op", () => {
  it("launches a disposable network-none installer with only the shared volume and Docker socket", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-live-isolated-"));
    temporaryRoots.push(root);
    const stateRoot = join(root, "state-home", "dim", "control-plane");
    await mkdir(join(root, "operator"), { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    const generationId = "a".repeat(64);
    const installBytes = Buffer.from(`${JSON.stringify({ generationId })}\n`);
    const composeBytes = Buffer.from("services: {}\n");
    await writeFile(join(root, "operator", "install.json"), "{}\n");
    await writeFile(join(stateRoot, "install.json"), installBytes);
    await writeFile(join(stateRoot, "compose.yml"), composeBytes);
    const calls = [];
    const runner = {
      async run(command) {
        calls.push(command);
        return calls.length === 1
          ? {
              exitCode: 0,
              stdout: "isolated-no-op localhost-native=ECONNREFUSED localhost-ordinary=ECONNREFUSED facade-exit=0 generation="
                + `${generationId} command=installer,install,control-plane,--config network=none socket=mounted `
                + "volume=same-absolute-path argv-secrets=0 env-secrets=0 output-secrets=0\n",
              stderr: ""
            }
          : { exitCode: 1, stdout: "", stderr: "No such container" };
      }
    };

    // When
    await runIsolatedFacadeNoOp({
      runner,
      root,
      stateRoot,
      harnessVolume: "harness-volume",
      daemonSocketSource: "/run/user/1000/docker.sock",
      containerName: "isolated-installer",
      image: "live-harness:test",
      verificationId: "test-run",
      generationId,
      ports: { nativeGit: 31001, ordinaryCi: 31002 },
      forbiddenValues: ["raw-readiness-token"],
      prior: {
        generationId,
        runtime: { nativeGit: { id: "native-id" }, ordinaryCi: { id: "ordinary-id" } },
        volumes: [{ Name: "native-volume" }],
        installBytes,
        composeBytes
      },
      captureRuntime: async () => ({ nativeGit: { id: "native-id" }, ordinaryCi: { id: "ordinary-id" } }),
      captureVolumes: async () => [{ Name: "native-volume" }],
      captureAuthority: async () => ({ network: "stable" }),
      assertSentinels: async () => {}
    });

    // Then
    assert.deepEqual(calls[0].args, [
      "container", "run", "--rm", "--name", "isolated-installer",
      "--label", "org.dim.verification=test-run", "--network", "none",
      "--mount", "type=bind,src=/run/user/1000/docker.sock,dst=/run/docker.sock",
      "--mount", `type=volume,src=harness-volume,dst=${root}`,
      "--env", `HARNESS_ROOT=${root}`,
      "--env", "ISOLATED_INSTALLER_NAME=isolated-installer",
      "--env", `EXPECTED_GENERATION=${generationId}`,
      "--env", "NATIVE_PORT=31001", "--env", "ORDINARY_PORT=31002",
      "live-harness:test", "node", join(root, "control-plane-install-live-isolated.mjs"), "child"
    ]);
    assert.deepEqual(calls[1].args, ["container", "inspect", "isolated-installer"]);
  });
});
