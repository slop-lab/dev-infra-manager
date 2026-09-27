import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const childDriver = String.raw`
  import { spawnSync } from "node:child_process";
  import { X509Certificate } from "node:crypto";
  import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { dirname, join } from "node:path";
  import { prepareQemuCiRunnerSupervisorImage } from "../core/packages/core/src/qemuCiRunnerSupervisorImage.ts";

  process.umask(0o077);
  const stateRoot = await mkdtemp(join(tmpdir(), "dim-qemu-supervisor-modes-"));
  const aptProbeRoot = await mkdtemp(join(tmpdir(), "dim-qemu-supervisor-apt-"));
  let snapshot;
  try {
    const runner = {
      async run(command, args) {
        const context = args.at(-1);
        const iidfileIndex = args.indexOf("--iidfile");
        const iidfile = iidfileIndex < 0 ? undefined : args[iidfileIndex + 1];
        if (command !== "docker" || context === undefined || iidfile === undefined) {
          throw new Error("complete Docker build arguments are required");
        }
        const assetNames = [
          "Dockerfile",
          "ubuntu.sources",
          "snapshot-ca.pem",
          "supervise.bash",
          "prepare-image.bash",
          "verify-ubuntu-image.bash",
          "webhook.py",
          "common.pkr.hcl",
          "project.pkr.hcl",
          "provision-common.bash"
        ];
        const modes = Object.fromEntries(await Promise.all(assetNames.map(async (name) => [
          name,
          (await stat(join(context, name))).mode & 0o777
        ])));
        const certificate = new X509Certificate(await readFile(join(context, "snapshot-ca.pem")));
        const now = new Date();

        await chmod(aptProbeRoot, 0o755);
        const aptCertificate = join(aptProbeRoot, "snapshot-ca.pem");
        await copyFile(join(context, "snapshot-ca.pem"), aptCertificate);
        const aptReadable = process.getuid?.() === 0
          ? spawnSync(process.execPath, ["--eval", "require('node:fs').readFileSync(process.argv[1])", aptCertificate], {
              uid: 65534,
              gid: 65534
            }).status === 0
          : (modes["snapshot-ca.pem"] & 0o004) !== 0;
        snapshot = {
          assetsParentMode: (await stat(dirname(context))).mode & 0o777,
          contextMode: (await stat(context)).mode & 0o777,
          modes,
          certificateValid: certificate.validFromDate <= now && now <= certificate.validToDate,
          aptReadable
        };
        await writeFile(iidfile, "sha256:" + "a".repeat(64) + "\n");
        return { command, args, stdout: "", stderr: "", exitCode: 0 };
      },
      async runStreaming() {
        return 0;
      }
    };
    await prepareQemuCiRunnerSupervisorImage(runner, stateRoot);
    console.log(JSON.stringify(snapshot));
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(aptProbeRoot, { recursive: true, force: true });
  }
`;

describe("QEMU CI supervisor image asset modes", () => {
  it("preserves intended asset access when the caller umask is 077", () => {
    // Given: an isolated Node process whose caller umask permits owner access only.
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childDriver], {
      cwd: new URL("../../..", import.meta.url),
      encoding: "utf8"
    });

    // When: the production image preparation reaches its Docker build runner.
    expect(child.status, child.stderr).toBe(0);

    // Then: public CA access is retained without widening the private build context or assets.
    expect(JSON.parse(child.stdout.trim())).toEqual({
      assetsParentMode: 0o700,
      contextMode: 0o700,
      modes: {
        Dockerfile: 0o600,
        "ubuntu.sources": 0o600,
        "snapshot-ca.pem": 0o644,
        "supervise.bash": 0o700,
        "prepare-image.bash": 0o700,
        "verify-ubuntu-image.bash": 0o700,
        "webhook.py": 0o700,
        "common.pkr.hcl": 0o600,
        "project.pkr.hcl": 0o600,
        "provision-common.bash": 0o700
      },
      certificateValid: true,
      aptReadable: true
    });
  });
});
