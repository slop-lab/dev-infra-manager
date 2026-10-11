import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readControlPlaneConfig } from "../../../../core/packages/installer/src/controlPlaneConfig.js";
import { ProcessControlPlaneDockerRunner } from "../../../../core/packages/installer/src/controlPlaneDocker.js";
import {
  ControlPlaneInstallError,
  formatControlPlaneInstallError
} from "../../../../core/packages/installer/src/controlPlaneInstallError.js";
import { installControlPlane } from "../../../../core/packages/installer/src/controlPlaneInstall.js";
import { controlPlaneSecrets } from "./controlPlaneFixture.js";
import { installFixture } from "./controlPlaneInstallTestSupport.js";

afterEach(() => vi.unstubAllEnvs());

describe("control-plane failure diagnostics", () => {
  it.each([
    ["check-config", "native-git configuration"],
    ["check-bundle-config", "bundle configuration"]
  ] as const)("reports successful digest pulls when %s rejects", async (failedCommand, stage) => {
    // Given: an explicit fake Docker runner that pulls both images before refusing a probe.
    const fixture = await installFixture();
    const root = join(fixture.stateRoot, "facade");
    const bin = join(root, "bin");
    const pullLog = join(root, "pull.log");
    await mkdir(bin, { recursive: true });
    const executable = join(bin, "docker");
    await writeFile(executable, fakeDocker, { mode: 0o755 });
    await chmod(executable, 0o755);
    vi.stubEnv("DIM_TEST_PULL_LOG", pullLog);
    vi.stubEnv("DIM_TEST_FAIL_PROBE", failedCommand);
    vi.stubEnv("DIM_TEST_HOSTILE_OUTPUT", `arbitrary-${controlPlaneSecrets.query}`);

    // When: installation uses the SDK's explicit process-runner test seam.
    const error = await installControlPlane({
      configPath: fixture.configPath,
      stateRoot: join(root, "state"),
      runner: new ProcessControlPlaneDockerRunner(executable)
    }).then(() => undefined, (reason: unknown) => reason);

    // Then: formatted diagnostics contain only fixed text and exact successful digest refs.
    const config = await readControlPlaneConfig(fixture.configPath, ["127.0.0.1"]);
    expect(error).toBeInstanceOf(ControlPlaneInstallError);
    if (!(error instanceof ControlPlaneInstallError)) throw new TypeError("expected control-plane install error");
    const diagnostics = formatControlPlaneInstallError(error).join("\n");
    expect(diagnostics).toContain(`preflight stage: ${stage}`);
    expect(diagnostics).toContain(`pulled image may remain cached: ${config.nativeGit.image}`);
    expect(diagnostics).toContain(`pulled image may remain cached: ${config.ordinaryCi.image}`);
    expect(diagnostics).not.toContain(controlPlaneSecrets.query);
    expect(diagnostics).not.toContain("arbitrary-");
    expect((await readFile(pullLog, "utf8")).trim().split("\n")).toEqual([
      config.nativeGit.image,
      config.ordinaryCi.image
    ]);
  });
});

const fakeDocker = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const ok = (value = "") => { process.stdout.write(value); process.exit(0); };
if (args[0] === "compose" && args[1] === "version") ok("5.0.0\\n");
if (args[1] === "inspect" && ["network", "volume", "container"].includes(args[0])) {
  const name = args[2];
  const diagnostic = args[0] === "network" ? "network " + name + " not found"
    : args[0] === "volume" ? "get " + name + ": no such volume" : "No such container: " + name;
  process.stderr.write("Error response from daemon: " + diagnostic + "\\n");
  process.exit(1);
}
if (args[1] === "ls") ok();
if (args[0] === "pull") { appendFileSync(process.env.DIM_TEST_PULL_LOG, args[1] + "\\n"); ok(); }
if (args[0] === "image" && args[1] === "inspect") {
  const image = args[2];
  ok(JSON.stringify([image]) + "\\n" + JSON.stringify(image.includes("native-git") ? "10001:10001" : "10002:10002") + "\\n");
}
if (args[0] === "run") {
  const probe = args.includes("check-bundle-config") ? "check-bundle-config" : "check-config";
  if (probe === process.env.DIM_TEST_FAIL_PROBE) {
    process.stdout.write(process.env.DIM_TEST_HOSTILE_OUTPUT);
    process.stderr.write(process.env.DIM_TEST_HOSTILE_OUTPUT);
    process.exit(1);
  }
  ok();
}
process.stderr.write("unexpected fake Docker command");
process.exit(99);
`;
