import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { collectHostClaims } from "../../../scripts/local-uninstall/host-resources.ts";
import { retainedPersistentData } from "../../../scripts/local-uninstall/persistent-data.ts";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { removalPaths } from "../../../scripts/local-uninstall/paths.ts";
import { createRemovalPlan, executeRemoval } from "../../../scripts/local-uninstall/plan.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";

it("preserves account authentication, usage SQLite and capture bytes while deleting workspace state", async () => {
  const home = await mkdtemp(join(tmpdir(), "dim-retain-llm-"));
  const paths = removalPaths({ HOME: home, XDG_RUNTIME_DIR: join(home, "run") });
  const service = join(paths.configuration, "llm"), state = join(paths.data, "custom-router-state"), auth = join(paths.data, "backend-auth");
  const capture = join(state, "captures", "request-id", "response.bin"), key = join(paths.data, "backend-api-key");
  const run: Command = async (file) => ({ status: 0, stdout: file === "mise" ? "[]" : "", stderr: "" });
  try {
    for (const dir of [service, auth, join(state, "captures/request-id"), join(paths.state, "discarded-checkout")]) await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(key, "private-key\n", { mode: 0o600 });
    await writeFile(join(auth, "codex.json"), '{"refresh_token":"keep-this"}', { mode: 0o600 });
    await writeFile(capture, Buffer.from([0, 1, 2, 255]), { mode: 0o600 });
    const dbFile = join(state, "router.sqlite3"), db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE usage(input INTEGER, output INTEGER); INSERT INTO usage VALUES(123,45)"); db.close();
    await writeFile(join(service, "router.json"), JSON.stringify({ schemaVersion: 3, stateDirectory: state, backend: { name: "CLIProxyAPI" },
      accounts: [{ keyFile: key, credentialDirectory: auth }], hostIssuers: [] }), { mode: 0o600 });
    const before = await readFile(dbFile);
    const plan = await createRemovalPlan(paths, run, { HOME: home });
    await executeRemoval(plan, run);
    expect(await readFile(key, "utf8")).toBe("private-key\n");
    expect(await readFile(join(auth, "codex.json"), "utf8")).toBe('{"refresh_token":"keep-this"}');
    expect(await readFile(capture)).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(dbFile)).toEqual(before);
    const restored = new DatabaseSync(dbFile); expect(restored.prepare("SELECT input,output FROM usage").get()).toMatchObject({ input: 123, output: 45 }); restored.close();
    await expect(stat(join(paths.state, "discarded-checkout"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stat(join(service, "router.json"))).toBeDefined();
    // A repeated uninstall preserves the same data, without needing workspace identity records.
    await executeRemoval(await createRemovalPlan(paths, run, { HOME: home }), run);
    expect(await readFile(dbFile)).toEqual(before);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("discovers a custom router config from an owned live process before stopping it", async () => {
  const home = await mkdtemp(join(tmpdir(), "dim-retain-service-"));
  const paths = removalPaths({ HOME: home, XDG_RUNTIME_DIR: join(home, "run") });
  const config = join(paths.data, "custom-service.json"), state = join(paths.data, "service-history"), script = join(paths.hostPlugins, "service.mjs");
  let child: ReturnType<typeof spawn> | undefined;
  const run: Command = async (file) => ({ status: 0, stdout: file === "mise" ? "[]" : "", stderr: "" });
  try {
    await mkdir(paths.hostPlugins, { recursive: true, mode: 0o700 }); await mkdir(state, { mode: 0o700 });
    await writeFile(script, 'setInterval(() => {}, 1000); process.stdout.write("ready\\n");');
    await writeFile(join(state, "usage.json"), '{"tokens":1234}', { mode: 0o600 });
    await writeFile(config, JSON.stringify({ schemaVersion: 3, stateDirectory: state, accounts: [], hostIssuers: [], backend: { name: "CLIProxyAPI" } }), { mode: 0o600 });
    child = spawn(process.execPath, [script, "--config", config], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      child!.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child!.once("error", reject);
      child!.once("exit", () => reject(new Error(`disposable service exited before readiness: ${stderr}`)));
      child!.stdout!.once("data", () => resolve());
    });
    const plan = await createRemovalPlan(paths, run, { HOME: home });
    expect(plan.processes.find((entry) => entry.pid === child!.pid)?.configFile).toBe(config);
    await executeRemoval(plan, run);
    expect(await readFile(config, "utf8")).toContain("CLIProxyAPI");
    expect(await readFile(join(state, "usage.json"), "utf8")).toBe('{"tokens":1234}');
    await expect(stat(script)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    await rm(home, { recursive: true, force: true });
  }
});
it("retains only Tailscale authentication among its exactly identified Docker resources", async () => {
  const home = await mkdtemp(join(tmpdir(), "dim-retain-tailscale-"));
  const paths = removalPaths({ HOME: home, XDG_RUNTIME_DIR: join(home, "run") });
  const directory = join(paths.state, "plugins/tailscale"), id = "11111111-1111-4111-8111-111111111111";
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const ledger = join(directory, "gateway.json");
    await writeFile(ledger, JSON.stringify({ schemaVersion: 1, id, hostname: "gateway", image: `example/tailscale@sha256:${"a".repeat(64)}` }), { mode: 0o600 });
    const claims = await collectHostClaims(paths);
    expect(claims).toHaveLength(3);
    expect(claims.map((claim) => claim.kind).sort()).toEqual(["container", "network", "volume"]);
    const persistence = await retainedPersistentData(paths, [], claims.map((claim) => ({ claim, id: claim.name, created: "now" })));
    expect(persistence.volumes).toEqual([claims.find((claim) => claim.kind === "volume")!.name]);
    expect(persistence.files).toContain(directory);
    expect(await readFile(ledger, "utf8")).toContain(id);
  } finally { await rm(home, { recursive: true, force: true }); }
});
