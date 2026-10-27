import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeStubCli } from "./support.js";
import {
  baseEnv,
  cleanupCliTempDirs,
  cliEntry,
  runCli,
  runCliDirect,
  tempDir,
  tsxPath
} from "./cliTestSupport.js";

afterEach(cleanupCliTempDirs);

describe("cli.ts dispatch (integration, via tsx subprocess)", () => {
  it("proxies unrecognized args, cwd, and facade env vars through to the configured CLI", async () => {
    const root = await tempDir("dim-cli-proxy-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    const echoFile = join(root, "echo.json");
    await writeStubCli(stub, { versionOutput: "5.5.5", echoFile });

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, cli: { mode: "proxied", version: "5.5.5", executable: stub } })
    );

    const cwd = await tempDir("dim-cli-proxy-cwd-");
    const result = await runCliDirect(["some", "random", "args", "--", "extra"], env, cwd);
    expect(result.code).toBe(0);

    const echoed = JSON.parse(await readFile(echoFile, "utf8"));
    expect(echoed.argv).toEqual(["some", "random", "args", "--", "extra"]);
    expect(echoed.cwd).toBe(await realpath(cwd));
    expect(echoed.env.DIM_INVOKED_VIA_INSTALLER).toBe("1");
    expect(echoed.env.DIM_INSTALLER_VERSION).toBe("0.10.0");
    expect(echoed.env.DIM_INSTALLER_ENTRYPOINT).toBe(cliEntry);
    expect(echoed.pid).toBe(result.pid);
  });

  it("does not load installer-only implementation for an ordinary proxied command", async () => {
    // Given
    const root = await tempDir("dim-cli-proxy-lazy-installer-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    const echoFile = join(root, "echo.json");
    await writeStubCli(stub, { versionOutput: "5.5.5", echoFile });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, cli: { mode: "proxied", version: "5.5.5", executable: stub } }));
    const hook = `import { registerHooks } from "node:module"; registerHooks({ resolve(specifier, context, nextResolve) { if (specifier.endsWith("/controlPlaneInstall.js")) throw new Error("installer-only module loaded"); return nextResolve(specifier, context); } });`;

    // When
    const result = await runCli(["ls"], tsxPath, {
      ...env,
      NODE_OPTIONS: `--import=${`data:text/javascript,${encodeURIComponent(hook)}`}`
    }, root);

    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(echoFile, "utf8")).argv).toEqual(["ls"]);
  });

  it("forwards --help to the configured CLI instead of intercepting it", async () => {
    const root = await tempDir("dim-cli-proxy-help-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    const echoFile = join(root, "echo.json");
    await writeStubCli(stub, { versionOutput: "5.5.5", echoFile });

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, cli: { mode: "proxied", version: "5.5.5", executable: stub } })
    );

    const result = await runCli(["--help"], tsxPath, env, root);
    expect(result.code).toBe(0);
    const echoed = JSON.parse(await readFile(echoFile, "utf8"));
    expect(echoed.argv).toEqual(["--help"]);
  });

  it("bare dim proxies to the configured CLI instead of opening the interactive installer", async () => {
    const root = await tempDir("dim-cli-proxy-bare-");
    const { env, configPath } = await baseEnv(root);
    const stub = join(root, "dim-stub.mjs");
    const echoFile = join(root, "echo.json");
    await writeStubCli(stub, { versionOutput: "5.5.5", echoFile });

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, cli: { mode: "proxied", version: "5.5.5", executable: stub } })
    );

    const result = await runCli([], tsxPath, env, root);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("interactive installation requires a TTY");
    const echoed = JSON.parse(await readFile(echoFile, "utf8"));
    expect(echoed.argv).toEqual([]);
  });
});
