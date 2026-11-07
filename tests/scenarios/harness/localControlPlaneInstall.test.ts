import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { installLocalControlPlane, type LocalControlPlaneOperations } from "../../../scripts/install-local-control-plane.ts";
import { installLocalProfile } from "../../../scripts/install-local-profile.ts";
import type { ControlPlaneInstalledState } from "../../../packages/installer/src/controlPlaneState.js";
import type { Command } from "../../../scripts/local-uninstall/command.ts";
import { ensureLocalCiQuery } from "../../../scripts/local-control-plane/ci-query.ts";
import { parseControlPlaneServicePair } from "../../../packages/control-plane/admin/src/service-pair.js";
import { idleNativeConfig, idleExecutionConfig } from "../../control-plane/plugins/git-repositories/bundleConfigFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = "a".repeat(64), id = `sha256:${sha}`;
async function fixture(existing = false) {
  const root = await mkdtemp(join(tmpdir(), "dim-full-local-install-")); roots.push(root);
  const bundle = join(root, "bundle"); await mkdir(bundle);
  await writeFile(join(bundle, "control-plane-images.json"), JSON.stringify({ schemaVersion: 1,
    "native-git": { tag: "dim-local-native-git:test", id }, execution: { tag: "dim-local-execution:test", id } }));
  const env = { HOME: root, DIM_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  const calls: string[][] = [];
  const run: Command = async (file, args) => {
    calls.push([file, ...args]);
    return { status: 0, stderr: "", stdout: args.includes("{{.Id}}") ? `${id}\n`
      : args.includes("{{json .RepoDigests}}") ? JSON.stringify([`127.0.0.1:5555/dim/${args.at(-1)!.includes("/git-service:") ? "git-service" : "execution-service"}@${id}`]) : "" };
  };
  const retainedNative = { ...idleNativeConfig(), gitSync: { operators: [{ hostId: "host-a", username: "sync-operator", password: Buffer.alloc(32, 42).toString("base64url") }] } };
  const retainedExecution = idleExecutionConfig(); retainedExecution.workers[0]!.id = "existing-worker";
  const prior = { record: { deploymentId: "dim", nativeGitImage: `prior.example/native@${id}`, executionImage: `prior.example/execution@${id}`, nativeGitPublish: { host: "127.0.0.1", port: 3310 }, executionPublish: { host: "127.0.0.1", port: 3311 } },
    snapshots: { nativeGit: { config: Buffer.from(JSON.stringify(retainedNative)), readinessToken: Buffer.from("native-token") },
      execution: { config: Buffer.from(JSON.stringify(retainedExecution)), readinessToken: Buffer.from("execution-token") } } } as ControlPlaneInstalledState;
  const ops: LocalControlPlaneOperations = {
    current: async () => existing ? prior : undefined,
    validateServicePair: parseControlPlaneServicePair,
    async registry() { calls.push(["registry"]); return "127.0.0.1:5555"; },
    async prepare(options) {
      calls.push(["prepare"]); await mkdir(options.directory);
      await writeFile(join(options.directory, "native-git.json"), JSON.stringify(retainedNative), { mode: 0o600 });
      await writeFile(join(options.directory, "execution.json"), JSON.stringify(retainedExecution), { mode: 0o600 });
      await writeFile(join(options.directory, "install.json"), JSON.stringify({ schemaVersion: 1, deploymentId: "dim",
        nativeGit: { image: options.nativeGitImage, configFile: join(options.directory, "native-git.json") },
        execution: { image: options.executionImage, configFile: join(options.directory, "execution.json") } }), { mode: 0o600 });
    },
    async deploy(config, _state, _backups, prior) { calls.push(["deploy", prior ? "checkpoint-update" : "first-install"]); expect(JSON.parse(await readFile(config, "utf8")).nativeGit.image).toBe(`127.0.0.1:5555/dim/git-service@${id}`); },
    async connect(directory, output) {
      calls.push(["connect"]); expect(JSON.parse(await readFile(join(directory, "install.json"), "utf8")).execution.image).toBe(`127.0.0.1:5555/dim/execution-service@${id}`);
      return { directory: output, generationId: sha, hostId: "dim-local", executionWorkerCount: 0 };
    },
    async select() { calls.push(["select"]); }
  };
  return { root, bundle, env, calls, run, ops };
}
it("installs both prepared service images, deploys, and selects fresh generation connections", async () => {
  const f = await fixture(); await installLocalControlPlane(f.bundle, f.env, f.run, f.ops);
  expect(f.calls.filter(([name]) => name !== "docker").map(([name]) => name)).toEqual(["registry", "prepare", "deploy", "connect", "select"]);
  expect(f.calls).toContainEqual(["deploy", "first-install"]);
  expect(f.calls.filter((args) => args[1] === "push")).toHaveLength(2);
});
it("adopts deployed credentials, ports and worker profiles without touching workspace data", async () => {
  const f = await fixture(true), workspace = join(f.root, ".local/state/dim/managed/workspaces");
  await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, "sentinel"), "checkout/home/docker data");
  await installLocalControlPlane(f.bundle, f.env, f.run, f.ops);
  expect(f.calls).toContainEqual(["deploy", "checkpoint-update"]); expect(f.calls).not.toContainEqual(["prepare"]);
  const setup = join(f.env.XDG_CONFIG_HOME, "dim/local-control-plane");
  const native = JSON.parse(await readFile(join(setup, "native-git.json"), "utf8"));
  const execution = JSON.parse(await readFile(join(setup, "execution.json"), "utf8"));
  expect(native.gitSync.operators[0].password).toBe(Buffer.alloc(32, 42).toString("base64url"));
  expect(native.ci.query).toEqual(execution.credentials.query);
  expect(execution.workers[0].id).toBe("existing-worker");
  expect(JSON.parse(await readFile(join(setup, "install.json"), "utf8")).nativeGit.publish.port).toBe(3310);
  expect(await readFile(join(workspace, "sentinel"), "utf8")).toBe("checkout/home/docker data");
  expect(f.calls.some((args) => args.includes("rm") || args.includes("stop"))).toBe(false);
});
it("refuses a retagged prepared image before deploying services or changing selection", async () => {
  const f = await fixture(true);
  const changed: Command = async () => ({ status: 0, stdout: `sha256:${"b".repeat(64)}`, stderr: "" });
  await expect(installLocalControlPlane(f.bundle, f.env, changed, f.ops)).rejects.toThrow("image changed");
  expect(f.calls).toEqual([]);
});
it("does not reconnect or publish candidate configuration after a failed checkpoint update", async () => {
  const f = await fixture(true);
  f.ops.deploy = async () => { throw new Error("checkpoint restored"); };
  await expect(installLocalControlPlane(f.bundle, f.env, f.run, f.ops)).rejects.toThrow("checkpoint restored");
  expect(f.calls.some(([name]) => name === "connect" || name === "select")).toBe(false);
  expect(JSON.parse(await readFile(join(f.env.XDG_CONFIG_HOME, "dim/local-control-plane/install.json"), "utf8")).nativeGit.image).toBe(`prior.example/native@${id}`);
});
it("updates every bundled host and control-plane plugin through the matching facade", async () => {
  const f = await fixture();
  const packages = ["host-plugin-agent-tools", "host-plugin-native-git", "control-plane-plugin-git-repositories", "control-plane-plugin-llm-router", "installer"].map((suffix) => ({ name: `@slop-lab/dim-${suffix}`, version: "0.10.0-local-test" }));
  await writeFile(join(f.bundle, "packages.json"), JSON.stringify({ schemaVersion: 1, packages }));
  await installLocalProfile(f.bundle, "/matching/facade", f.run);
  expect(f.calls).toEqual([
    ["/matching/facade", "installer", "install", "plugin", "--local-packages", f.bundle, "@slop-lab/dim-host-plugin-agent-tools@0.10.0-local-test", "@slop-lab/dim-host-plugin-native-git@0.10.0-local-test"],
    ["/matching/facade", "installer", "install", "control-plane", "plugin", "--local-packages", f.bundle, "@slop-lab/dim-control-plane-plugin-git-repositories@0.10.0-local-test", "@slop-lab/dim-control-plane-plugin-llm-router@0.10.0-local-test"]
  ]);
});

it("loads the real local control-plane helper from a dependency-free source checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-pristine-local-helper-")); roots.push(root);
  // Fresh bootstrap prepares packages in a separate source stage. The original
  // checkout has scripts, but no workspace dependencies or compiled packages.
  await cp(resolve(import.meta.dirname, "../../../scripts"), join(root, "scripts"), { recursive: true });
  const module = pathToFileURL(join(root, "scripts/install-local-control-plane.ts")).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const helper = await import(${JSON.stringify(module)}); if (typeof helper.installLocalControlPlane !== "function") process.exit(2);`],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
});

it("rejects invalid paired query credentials before rewriting the existing service config", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-pair-query-reject-")); roots.push(root);
  const native = idleNativeConfig(), execution = idleExecutionConfig();
  execution.credentials.query = { ...native.ci.webhook };
  const nativeFile = join(root, "native.json"), executionFile = join(root, "execution.json");
  const before = JSON.stringify(native);
  await writeFile(nativeFile, before, { mode: 0o600 });
  await writeFile(executionFile, JSON.stringify(execution), { mode: 0o600 });
  await expect(ensureLocalCiQuery(nativeFile, executionFile, parseControlPlaneServicePair)).rejects.toThrow();
  expect(await readFile(nativeFile, "utf8")).toBe(before);
});
