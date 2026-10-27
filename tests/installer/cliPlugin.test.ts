import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFakeCliNpm, writeFakePluginNpm, writeStubCli } from "./support.js";
import { baseEnv, cleanupCliTempDirs, npmArguments, runCli, tempDir, tsxPath } from "./cliTestSupport.js";

afterEach(cleanupCliTempDirs);

describe("cli.ts dispatch (integration, via tsx subprocess)", () => {
  it("dim installer install plugin requires the host runtime first", async () => {
    const root = await tempDir("dim-plugin-before-cli-");
    const { env } = await baseEnv(root);
    const result = await runCli(["installer", "install", "plugin", "@example/plugin@1.0.0"], tsxPath, env, root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("host must be installed before host plugins");
  });

  it("rejects a missing host before plugin npm mutation", async () => {
    // Given
    const root = await tempDir("dim-plugin-missing-configured-cli-");
    const { env, configPath } = await baseEnv(root);
    const bin = join(root, "bin");
    const npmArgs = join(root, "npm-args.json");
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      cli: { mode: "proxied", version: "1.0.0", executable: join(root, "missing-dim") }
    }));
    await writeFakeCliNpm(join(bin, "npm"), { argsFile: npmArgs, versionOutput: "1.0.0" });

    // When
    const result = await runCli(
      ["installer", "install", "plugin", "@example/plugin@1.0.0"],
      tsxPath,
      { ...env, PATH: `${bin}:${env.PATH}` },
      root
    );

    // Then
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("host must be installed");
    await expect(access(npmArgs)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs host plugins without requiring a presentation CLI", async () => {
    const root = await tempDir("dim-plugin-without-cli-");
    const { env, dataHome } = await baseEnv(root);
    const executable = join(dataHome, "runtime/current/node_modules/.bin/dim-host");
    await mkdir(dirname(executable), { recursive: true });
    await writeStubCli(executable, { versionOutput: "2.0.0" });
    const bin = join(root, "bin"); await mkdir(bin);
    const npmArgs = join(root, "npm-args.json");
    await writeFakePluginNpm(join(bin, "npm"), { argsFile: npmArgs });
    const result = await runCli(["installer", "install", "plugin", "@example/plugin@1.0.0"], tsxPath, { ...env, PATH: `${bin}:${env.PATH}` }, root);
    expect(result.code, result.stderr).toBe(0);
    expect(await npmArguments(npmArgs)).toContain("@example/plugin@1.0.0");
  });

  it("enables multiple installed plugins in one command", async () => {
    const root = await tempDir("dim-enable-plugins-");
    const { env, configPath, dataHome } = await baseEnv(root);
    const pluginHome = join(dataHome, "runtime", "current");
    const executable = join(pluginHome, "node_modules", ".bin", "dim-host");
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(executable), { recursive: true });
    await writeStubCli(executable, { versionOutput: "0.9.0" });
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      cli: { mode: "proxied", version: "0.9.0", executable }
    }));
    await writeFile(join(pluginHome, "package.json"), JSON.stringify({
      private: true,
      dependencies: { "plugin-one": "1.0.0", "plugin-two": "2.0.0" }
    }));
    await writeFile(join(pluginHome, "plugins.json"), '{"schemaVersion":1,"plugins":[]}\n');

    for (const name of ["plugin-one", "plugin-two"]) {
      const directory = join(pluginHome, "node_modules", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
      await writeFile(join(directory, "index.js"), "// @ts-check\nexport const hostPlugin = {name:'fixture'};\n");
    }

    const result = await runCli(["installer", "enable-plugin", "plugin-two", "plugin-one"], tsxPath, env, root);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Enabled plugin-two\nEnabled plugin-one\n");
    expect(JSON.parse(await readFile(join(pluginHome, "plugins.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      plugins: ["plugin-one", "plugin-two"]
    });
  });
});
