import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hostMain = fileURLToPath(new URL("../../../../../packages/host/core/src/application/host-main.ts", import.meta.url));
const loader = fileURLToPath(new URL("../../../../node_modules/tsx/dist/loader.mjs", import.meta.url));

test("controller dispatch does not load workspace command or application owners", async () => {
  // Given
  const hook = `import { registerHooks } from "node:module"; registerHooks({ resolve(specifier, context, nextResolve) { if (specifier.endsWith("/host-application.js") || specifier.endsWith("/workspaces.js")) throw new Error("workspace owner loaded"); return nextResolve(specifier, context); } });`;

  // When
  const child = spawn(process.execPath, ["--disable-warning=DEP0205", "--conditions=dim-source", "--import", loader, hostMain, "controller", "--help"], {
    env: { ...process.env, NODE_OPTIONS: `--import=${`data:text/javascript,${encodeURIComponent(hook)}`}` },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  // Then
  assert.equal(status, 0, stderr);
  assert.match(stdout, /Usage: dim controller/);
  assert.doesNotMatch(stderr, /workspace owner loaded/);
});
