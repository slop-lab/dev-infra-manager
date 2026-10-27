import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFakeCliNpm, writeStubCli } from "./support.js";
import { baseEnv, cleanupCliTempDirs, npmArguments, runCli, tempDir, tsxPath } from "./cliTestSupport.js";

afterEach(cleanupCliTempDirs);

async function localBundleFixture() {
  const root = await tempDir("dim-cli-local-bundle-");
  const { env, configPath, dataHome } = await baseEnv(root);
  const bin = join(root, "bin"), bundle = join(root, "bundle"), npmArgs = join(root, "npm-args.json");
  await mkdir(bin, { recursive: true });
  await mkdir(bundle, { recursive: true });
  await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "0.9.0" });
  const packages = [
    { name: "@slop-lab/dim-host-core", version: "0.9.0", file: "core.tgz", requires: {} },
    { name: "@slop-lab/dim-cli", version: "0.9.0", file: "cli.tgz", requires: {} },
    { name: "@slop-lab/dim-control-plane-admin", version: "0.9.0", file: "admin.tgz", requires: { "@slop-lab/dim-host-core": "0.9.0", "@slop-lab/dim-control-plane-plugin-git-repositories": "0.9.0" } },
    { name: "@slop-lab/dim-control-plane-plugin-git-repositories", version: "0.9.0", file: "native-git.tgz", requires: { "@slop-lab/dim-contracts-external-url": "0.9.0" } },
    { name: "@slop-lab/dim-contracts-external-url", version: "0.9.0", file: "contract.tgz", requires: {} },
    { name: "@slop-lab/dim-host-plugin-native-git", version: "0.9.0", file: "native-host.tgz", requires: { "@slop-lab/dim-host-core": "0.9.0" } },
    { name: "@slop-lab/dim-host-plugin-execution-worker", version: "0.9.0", file: "worker.tgz", requires: { "@slop-lab/dim-host-core": "0.9.0" } },
    { name: "@slop-lab/dim-host-plugin-mirrors", version: "0.9.0", file: "mirrors.tgz", requires: { "@slop-lab/dim-host-core": "0.9.0" } },
    { name: "@slop-lab/dim-installer", version: "0.9.0", file: "installer.tgz", requires: {} }
  ];
  await Promise.all(packages.map(({ file }) => writeFile(join(bundle, file), "fixture archive")));
  await writeFile(join(bundle, "packages.json"), JSON.stringify({ schemaVersion: 1, packages }));
  return { root, env: { ...env, PATH: `${bin}:${env.PATH}` }, configPath, dataHome, bundle, npmArgs };
}

describe("cli.ts dispatch (integration, via tsx subprocess)", () => {
  it("installs only the base local package dependency closure behind the facade", async () => {
    const { root, env, configPath, dataHome, bundle, npmArgs } = await localBundleFixture();
    const result = await runCli(["installer", "install", "core", "--local-packages", bundle, "--no-local-bin"], tsxPath, env, root);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Installed local DIM host 0.9.0");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.cli).toMatchObject({ mode: "proxied", version: "0.9.0" });
    expect(config.cli.executable).toBe(join(dataHome, "cli/runtime/current/dim"));
    const args = await npmArguments(npmArgs);
    expect(args).toEqual(expect.arrayContaining([join(bundle, "core.tgz")]));
    for (const file of ["admin.tgz", "native-git.tgz", "contract.tgz", "mirrors.tgz", "installer.tgz"]) expect(args).not.toContain(join(bundle, file));
  });

  it("selects the administration profile and both matched local host plugins", async () => {
    const { root, env, bundle, npmArgs, dataHome } = await localBundleFixture();
    const result = await runCli(["installer", "install", "core", "--local-packages", bundle, "--no-local-bin", "--with-managed"], tsxPath, env, root);
    expect(result.code, result.stderr).toBe(0);
    const args = await npmArguments(npmArgs);
    for (const file of ["core.tgz", "admin.tgz", "native-git.tgz", "contract.tgz", "native-host.tgz", "worker.tgz"]) expect(args).toContain(join(bundle, file));
    expect(args).not.toContain(join(bundle, "mirrors.tgz"));
    expect(JSON.parse(await readFile(join(dataHome, "runtime/current/plugins.json"), "utf8"))).toEqual({ schemaVersion: 1, plugins: ["@slop-lab/dim-host-plugin-execution-worker", "@slop-lab/dim-host-plugin-native-git"] });
  });

  it("upgrades enabled local plugins and their required component peers from the matched bundle", async () => {
    const { root, env, bundle, npmArgs, dataHome } = await localBundleFixture();
    const current = join(dataHome, "runtime/current");
    await mkdir(current, { recursive: true });
    await writeFile(join(current, "package.json"), JSON.stringify({ dependencies: { "@slop-lab/dim-host-plugin-mirrors": "0.8.0" } }));
    await writeFile(join(current, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["@slop-lab/dim-host-plugin-mirrors"] }));
    const result = await runCli(["installer", "install", "core", "--local-packages", bundle, "--no-local-bin"], tsxPath, env, root);
    expect(result.code, result.stderr).toBe(0);
    const args = await npmArguments(npmArgs);
    expect(args).toContain(join(bundle, "mirrors.tgz"));
    expect(args).not.toContain(join(bundle, "admin.tgz"));
    expect(args).not.toContain("@slop-lab/dim-host-plugin-mirrors@0.8.0");
    expect(JSON.parse(await readFile(join(current, "plugins.json"), "utf8"))).toEqual({ schemaVersion: 1, plugins: ["@slop-lab/dim-host-plugin-mirrors"] });
  });

  it("updates core while retaining an independently installed compatible CLI release", async () => {
    const { root, env, configPath, dataHome, bundle, npmArgs } = await localBundleFixture();
    const executable = join(root, "independent-cli");
    await writeStubCli(executable, { versionOutput: "9.0.0" });
    await mkdir(dirname(configPath), { recursive: true });
    const cli = { mode: "proxied", version: "9.0.0", executable };
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, cli }));
    const result = await runCli(["installer", "install", "core", "--local-packages", bundle, "--no-local-bin"], tsxPath, env, root);
    expect(result.code, result.stderr).toBe(0);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.cli).toEqual(cli);
    expect(config.host).toEqual({ version: "0.9.0", executable: join(dataHome, "runtime/current/node_modules/.bin/dim-host") });
    expect(await npmArguments(npmArgs)).not.toContain(join(bundle, "cli.tgz"));
  });

  it("install cli updates only presentation behind an existing host", async () => {
    const { root, env, configPath, dataHome, bundle } = await localBundleFixture();
    const host = join(dataHome, "runtime/current/node_modules/.bin/dim-host");
    await mkdir(dirname(host), { recursive: true }); await writeStubCli(host, { versionOutput: "3.0.0" });
    await mkdir(dirname(configPath), { recursive: true });
    const hostConfig = { version: "3.0.0", executable: host };
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, host: hostConfig }));
    const result = await runCli(["installer", "install", "cli", "--local-packages", bundle, "--no-local-bin"], tsxPath, env, root);
    expect(result.code, result.stderr).toBe(0);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.host).toEqual(hostConfig); expect(config.cli.version).toBe("0.9.0");
    const version = await runCli(["__host", "--version"], tsxPath, env, root);
    expect(version.stdout.trim()).toBe("dim __host --version");
  });
});
