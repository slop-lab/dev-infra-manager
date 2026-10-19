import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { backendProfile, defaultLimits } from "../../../../packages/control-plane/plugins/llm-router/src/config.js";

it("starts the published control-plane plugin and operator CLI with only its SDK, without workspace core", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-standalone-"));
  try {
    const modules = join(root, "node_modules/@slop-lab"); await mkdir(modules, { recursive: true });
    const plugin = join(modules, "dim-plugin-control-plane-llm-router");
    await cp(fileURLToPath(new URL("../../../../packages/control-plane/plugins/llm-router/dist", import.meta.url)), plugin, { recursive: true });
    await cp(fileURLToPath(new URL("../../../../packages/control-plane/core/dist", import.meta.url)), join(modules, "dim-control-plane"), { recursive: true });
    await expect(stat(join(modules, "dim-core"))).rejects.toMatchObject({ code: "ENOENT" });
    const metadata: unknown = JSON.parse(await readFile(join(plugin, "package.json"), "utf8"));
    expect(metadata).toMatchObject({ dependencies: { "@slop-lab/dim-control-plane": expect.any(String) } });
    expect(JSON.stringify(metadata)).not.toContain("dim-core");
    const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address(); if (!address || typeof address === "string") throw new Error("missing port");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const config = join(root, "router.json");
    await writeFile(config, JSON.stringify({ schemaVersion: 3, stateDirectory: join(root, "state"), hostIssuers: [],
      listen: { host: "127.0.0.1", port: address.port }, backend: backendProfile,
      accounts: [{ id: "default", reference: "exclusive", endpoint: "http://127.0.0.1:8317", keyFile: join(root, "not-needed-until-inference.key") }],
      routes: [{ id: "default", accountId: "default", models: [{ id: "reviewed", name: "Reviewed", api: "responses", context: 10000, output: 1000 }] }], limits: defaultLimits }), { mode: 0o600 });
    const execute = promisify(execFile);
    await execute(process.execPath, [join(plugin, "main.js"), "project-add", "application", "--config", config], { cwd: root, timeout: 10_000 });
    const result = await execute(process.execPath, ["--input-type=module", "-e", `
      import { controlPlanePlugin } from "@slop-lab/dim-plugin-control-plane-llm-router";
      const configured = await controlPlanePlugin.configure(process.env.DIM_ROUTER_TEST_CONFIG);
      const service = await configured.start({signal:new AbortController().signal});
      await service.close(); console.log("standalone-listener-ready");
    `], { cwd: root, timeout: 10_000, env: { ...process.env, DIM_ROUTER_TEST_CONFIG: config } });
    expect(result.stdout.trim()).toBe("standalone-listener-ready");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
