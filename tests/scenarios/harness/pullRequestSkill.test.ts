import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const detector = resolve(import.meta.dirname, "../../../.agents/skills/pull-request/scripts/detect-forge.bash");

it.each([
  "https://github.com/slop-lab/dev-infra-manager.git",
  "https://github.com:443/slop-lab/dev-infra-manager/",
  "git@github.com:slop-lab/dev-infra-manager.git",
  "ssh://git@github.com/slop-lab/dev-infra-manager.git",
  "ssh://git@github.com:22/slop-lab/dev-infra-manager.git",
  "ssh://git@ssh.github.com:443/slop-lab/dev-infra-manager.git"
])("identifies the canonical GitHub target offline: %s", async (url) => {
  await fixture(async (root) => {
    await execute("git", ["remote", "add", "public", url], { cwd: root });
    const { stdout } = await execute("bash", [detector, "--remote", "public"], { cwd: root });
    expect(JSON.parse(stdout)).toEqual({ provider: "github", remote: "public", remoteUrl: "https://github.com/slop-lab/dev-infra-manager.git", forgeUrl: "https://github.com", repository: "slop-lab/dev-infra-manager" });
  });
});

it.each([
  "http://127.0.0.1:3300/dim-dim/dim.git",
  "http://10.0.0.1:19419/v1/projects/project/repositories/root.git",
  "https://github.com/one/two/three.git",
  "https://github.com.fake.invalid/slop-lab/dev-infra-manager.git",
  "https://operator:private-test-token@github.com/slop-lab/dev-infra-manager.git"
])("rejects noncanonical/scoped/credential URLs without network or credential discovery", async (url) => {
  await fixture(async (root) => {
    const bin = join(root, "bin"); await mkdir(bin);
    for (const command of ["curl", "gh"]) await writeFile(join(bin, command), `#!/bin/sh\nprintf invoked > '${join(root, "network-called")}'\nexit 70\n`, { mode: 0o700 });
    await execute("git", ["remote", "add", "origin", url], { cwd: root });
    let output = "";
    try { await execute("bash", [detector], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }); throw new Error("unsupported remote was accepted"); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !("stdout" in error) || !("stderr" in error)) throw error;
      expect(error.code).toBe(3); output = String(error.stdout) + String(error.stderr);
      expect(JSON.parse(String(error.stdout))).toMatchObject({ provider: "unknown", remote: "origin" });
    }
    expect(output).not.toContain(url);
    expect(output).not.toMatch(/private-test-token|operator|unexpected-network/);
    await expect(readFile(join(root, "network-called"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixture(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dim-pr-skill-"));
  try { await execute("git", ["init", "--quiet", root]); await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
