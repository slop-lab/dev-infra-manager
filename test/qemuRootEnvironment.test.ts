import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../../project");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU root environment", () => {
  it("ignores a first-PATH Node and inherited preload for root commands", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-root-environment-test-"));
    roots.push(root);
    const tools = resolve(root, "tools");
    const serviceDirectory = resolve(root, "service");
    await mkdir(tools);
    const pathSentinel = resolve(root, "path-node-ran");
    const preloadSentinel = resolve(root, "preload-ran");
    const preload = resolve(root, "preload.mjs");
    await writeFile(resolve(tools, "node"), `#!/bin/sh\nprintf ran >${JSON.stringify(pathSentinel)}\nexit 91\n`);
    await writeFile(resolve(tools, "sudo"), "#!/bin/sh\n[ \"$1\" != -n ] || shift\nexport DIM_TEST_ROOT_COMMAND=1\nexec \"$@\"\n");
    await writeFile(preload, `import { writeFileSync } from "node:fs";\nif(process.env.DIM_TEST_ROOT_COMMAND)writeFileSync(${JSON.stringify(preloadSentinel)},"ran")\n`);
    await Promise.all(["node", "sudo"].map((name) => chmod(resolve(tools, name), 0o700)));
    const setup = await readFile(resolve(projectRoot, ".dim/setup.sh"), "utf8");
    const start = setup.indexOf("qemu_service_dir=/tmp/dim-qemu-verification");
    const end = setup.indexOf("\n# Avoid inheriting", start);
    const section = setup.slice(start, end)
      .replace("qemu_service_dir=/tmp/dim-qemu-verification", `qemu_service_dir=${JSON.stringify(serviceDirectory)}`)
      .replace("qemu_node=/usr/bin/node", `qemu_node=${JSON.stringify(process.execPath)}`);
    const teardown = await readFile(resolve(projectRoot, ".dim/teardown.sh"), "utf8");
    const teardownStart = teardown.indexOf("qemu_service_dir=/tmp/dim-qemu-verification");
    const teardownEnd = teardown.indexOf("\nset -- down", teardownStart);
    const teardownSection = teardown.slice(teardownStart, teardownEnd)
      .replace("qemu_service_dir=/tmp/dim-qemu-verification", `qemu_service_dir=${JSON.stringify(serviceDirectory)}`)
      .replace("qemu_node=/usr/bin/node", `qemu_node=${JSON.stringify(process.execPath)}`);

    const results = [section, teardownSection].map((command) => spawnSync("/bin/sh", ["-c", `set -eu\n${command}`], {
      cwd: projectRoot, encoding: "utf8",
      env: { ...process.env, DIM_WORKSPACE_KVM: "0", NODE_OPTIONS: `--require=${preload}`, PATH: `${tools}:/usr/bin:/bin` },
    }));

    expect.soft(results.map(({ status }) => status), results.map(({ stderr }) => stderr).join("\n")).toEqual([0, 0]);
    await expect(readFile(pathSentinel)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(preloadSentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
