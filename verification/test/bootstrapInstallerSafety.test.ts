import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  await chmod(path, 0o755);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bootstrap installer safety", () => {
  it("rejects an existing source-tool target with the wrong pnpm version", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-source-tools-policy-"));
    roots.push(root);
    const tools = resolve(root, "tools");
    const target = resolve(root, "target");
    const installer = resolve(root, "install-source-tools.bash");
    const nodeInstaller = resolve(root, "node-installer.bash");
    await Promise.all([mkdir(tools), mkdir(resolve(target, "bin"), { recursive: true })]);
    await executable(resolve(tools, "dpkg"), "printf 'amd64\\n'\n");
    await executable(resolve(tools, "apt-get"), ":\n");
    await executable(nodeInstaller, ":\n");
    await executable(resolve(target, "bin/pnpm"), "printf '10.13.0\\n'\n");
    await executable(resolve(target, "bin/just"), "printf 'just 1.43.1\\n'\n");
    const source = await readFile(resolve(workspaceRoot, "verification/scripts/lib/install-source-tools-ubuntu.bash"), "utf8");
    await writeFile(installer, source
      .replace(/^node_installer=.*$/m, `node_installer=${JSON.stringify(nodeInstaller)}`)
      .replace(/^target=.*$/m, `target=${JSON.stringify(target)}`));

    // When
    const result = spawnSync("/usr/bin/bash", [installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tools}:/usr/bin:/bin`,
        pins_helper: resolve(workspaceRoot, "scripts/lib/bootstrap-ubuntu-pins.bash"),
      },
    });

    // Then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("foreign source tool target");
    expect(source).toMatch(/pnpm --version\)" == "\$dim_pnpm_version" \]\] &&/);
  });

  it("rejects distro Docker conflicts before any APT command", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-docker-conflict-policy-"));
    roots.push(root);
    const tools = resolve(root, "tools");
    const installer = resolve(root, "install-docker-ce.bash");
    const aptLog = resolve(root, "apt.log");
    await mkdir(tools);
    await writeFile(aptLog, "");
    await executable(resolve(tools, "id"), "printf '0\\n'\n");
    await executable(resolve(tools, "dpkg"), "printf 'amd64\\n'\n");
    await executable(resolve(tools, "dpkg-query"), `
if [[ "$*" == *docker.io* ]]; then printf 'install ok installed'; exit 0; fi
exit 1
`);
    await executable(resolve(tools, "apt-get"), `printf 'apt-get %s\\n' "$*" >>${JSON.stringify(aptLog)}\n`);
    await executable(resolve(tools, "curl"), "exit 99\n");
    await writeFile(installer, await readFile(resolve(workspaceRoot, "verification/scripts/lib/install-docker-ce-ubuntu.bash"), "utf8"));

    // When
    const result = spawnSync("/usr/bin/bash", [installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tools}:/usr/bin:/bin`,
        pins_helper: resolve(workspaceRoot, "scripts/lib/bootstrap-ubuntu-pins.bash"),
      },
    });

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("docker.io");
    expect(await readFile(aptLog, "utf8")).toBe("");
  });
});
