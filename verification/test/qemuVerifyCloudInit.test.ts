import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const qemuVerify = resolve(import.meta.dirname, "../../.dim/qemu-verify.bash");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU verification guest shell environment", () => {
  it("defines PS1 before a strict noninteractive Bash reads its startup file", async () => {
    // Given
    const script = await readFile(qemuVerify, "utf8");
    const cloudConfigSource = script.replaceAll("\\n", "\n");
    const configuredPs1 = cloudConfigSource.match(/path: \/etc\/environment[\s\S]*?content: \|\n\s+PS1=(.*)/)?.[1];
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-shell-environment-"));
    temporaryRoots.push(root);
    const startup = resolve(root, "bash.bashrc");
    await writeFile(startup, '[ -z "$PS1" ] && return\n');

    // When
    const result = spawnSync("bash", ["-uc", "true"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BASH_ENV: startup,
        ...(configuredPs1 === undefined ? { PS1: undefined } : { PS1: configuredPs1 })
      }
    });

    // Then
    expect(configuredPs1).toBe("");
    expect(result.status, result.stderr).toBe(0);
  });

});
