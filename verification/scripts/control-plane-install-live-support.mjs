import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

export async function installWithFacade(input) {
  const result = await runFacade(input);
  assert.equal(result.exitCode, 0, `facade install failed: ${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Installed control-plane generation [0-9a-f]{64}\nServices: native-git, ordinary-ci\n$/);
  for (const secret of input.forbiddenOutput) {
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
  }
  return { record: JSON.parse(await readFile(join(input.stateRoot, "install.json"), "utf8")) };
}

export async function runFacade(input) {
  return await runFacadeCommand(input, ["installer", "install", "control-plane", "--config", input.configPath]);
}

export async function runFacadeCommand(input, args) {
  return await run(input.executable, args, input.cwd, input.environment);
}

export async function unusedPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.notEqual(address, null);
      assert.equal(typeof address, "object");
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

async function run(executable, args, cwd, environment) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (signal !== null) return reject(new Error(`facade terminated by ${signal}`));
      resolve({ exitCode, stdout, stderr });
    });
  });
}
