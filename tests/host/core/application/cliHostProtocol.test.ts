import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

const execute = promisify(execFile);
const hostMain = fileURLToPath(new URL("../../../../packages/host/core/src/application/host-main.ts", import.meta.url));
const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));

// Frozen client v1 bytes: deliberately do not import the current codec here.
// A future protocol must retain this fixture and add its own, not rewrite it.
const frozenClientV1 = (operation: string, input: unknown) => Buffer.from(JSON.stringify({
  protocol: "dim.cli-host", version: 1, operation, input
})).toString("base64url");

it("accepts a frozen v1 client without binding its release to the host or its feature commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-cli-host-v1-"));
  try {
    const pluginHome = join(root, "plugins"), plugin = join(pluginHome, "node_modules", "future-plugin");
    await mkdir(plugin, { recursive: true, mode: 0o700 });
    await writeFile(join(pluginHome, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["future-plugin"] }));
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "future-plugin", version: "99.0.0", type: "module", exports: "./index.mjs" }));
    const marker = join(root, "executed");
    await writeFile(join(plugin, "index.mjs"), `// @ts-check\nimport{writeFile}from'node:fs/promises';export const hostPlugin={name:'future',commands:[{name:'future-command',description:'A command unknown to the frozen client'}],async run(args){await writeFile(${JSON.stringify(marker)},JSON.stringify(args));console.log(JSON.stringify({received:args}));}};`);
    const run = (encoded: string) => execute(process.execPath, ["--disable-warning=DEP0205", "--conditions=dim-source", "--import", loader, hostMain, "__host", encoded], {
      env: { ...process.env, DIM_PLUGIN_HOME: pluginHome, DIM_STATE_ROOT: join(root, "state") }
    });
    const capabilities = await run(frozenClientV1("capabilities", {}));
    assert.deepEqual(JSON.parse(capabilities.stdout), { protocol: "dim.cli-host", versions: [1] });
    const args = ["future-command", "--a-new-host-option", "a b", "", "$(must-stay-literal)"];
    const result = await run(frozenClientV1("command", { args }));
    assert.deepEqual(JSON.parse(result.stdout), { received: args });
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), args);
    await rm(marker);
    const unsupported = Buffer.from(JSON.stringify({ protocol: "dim.cli-host", version: 999, operation: "command", input: { args } })).toString("base64url");
    await assert.rejects(run(unsupported), (error: unknown) => error instanceof Error && "code" in error && error.code === 2 && "stderr" in error && /Unsupported DIM CLI\/host protocol/.test(String(error.stderr)));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
