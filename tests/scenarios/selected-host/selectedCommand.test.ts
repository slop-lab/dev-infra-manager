import { mkdir, mkdtemp, rm, writeFile, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { HostProfile } from "./config.js";
import { fixtureFailureWriter, selectedCommandTracker } from "./selectedCommand.js";

const profile: HostProfile = { name: "fixture", workspace: "dim-smoke-test", source: "/private/repo", workspaceSourceSha: "a".repeat(40),
  expectedHostVersion: "0.10.0", requiredPlugins: [], ingress: "shared", sshPublicKey: "fixture", llm: { configFile: "/private/gateway.json", project: "smoke", route: "default", provider: "dim-responses", model: "reviewed-model", operatorConnectionFile: "/private/read-only.json" } };

it("retains failed command exit evidence without recording scripts, prompts or raw private output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-command-evidence-")), bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "dim"), `#!${process.execPath}\nprocess.stderr.write("PRIVATE_STDERR");process.exit(7);\n`, { mode: 0o700 });
  vi.stubEnv("DIM_BIN", path.join(bin, "dim"));
  try {
    const tracker = selectedCommandTracker();
    await expect(tracker.checked(profile, "scoped command", ["exec", "dim-smoke-test", "--", "node", "-e", "PRIVATE_SCRIPT"]))
      .rejects.toThrow("command exited 7");
    expect(tracker.commands[0]).toMatchObject({ step: "scoped command", exitCode: 7, surface: ["dim", "--host", "fixture", "exec", "<owned-workspace>", "--", "node"] });
    expect(JSON.stringify(tracker.commands)).not.toContain("PRIVATE");
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it.each([
  { args: ["vm", "start", "owned"], stderr: "dim-host: VM startup deadline exceeded while waiting for guest Docker; last Incus readiness probe failed (exit 1): Error: local error: tls: bad record MAC\n", diagnostic: "vm-startup-timeout" },
  { args: ["vm", "start", "owned"], stderr: "dim-host: VM startup deadline exceeded while waiting for guest Docker\n", diagnostic: "vm-startup-timeout" },
  { args: ["vm", "start", "owned"], stderr: "dim: VM guest readiness failed: PRIVATE_INCUS_DETAILS\n", diagnostic: "vm-agent-probe-failed" },
  { args: ["vm", "start", "owned"], stderr: "dim-host: VM guest Docker readiness failed: PRIVATE_DOCKER_DETAILS\n", diagnostic: "vm-docker-probe-failed" },
  { args: ["vm", "start", "owned"], stderr: "dim-host: auxiliary VM image must provide writable /workspace and private mode-0700 /mnt/dim-tmp for user dim\n", diagnostic: "vm-guest-layout-invalid" },
  { args: ["vm", "start", "owned"], stderr: "dim-host: PRIVATE_UNKNOWN_FAILURE\n", diagnostic: undefined },
  { args: ["vm", "start", "owned"], stderr: "dim-host: VM guest readiness failed: PRIVATE_INCUS_DETAILS\nPRIVATE_SECOND_LINE", diagnostic: undefined },
  { args: ["exec", "owned", "--", "node"], stderr: "dim-host: VM guest agent did not become ready; verify the reviewed image and Incus agent payload before retrying\n", diagnostic: undefined },
])("retains only the closed VM readiness classification: $diagnostic", async ({ args, stderr, diagnostic }) => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-vm-diagnostic-")), executable = path.join(root, "dim");
  await writeFile(executable, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(stderr)});process.exit(2);\n`, { mode: 0o700 });
  vi.stubEnv("DIM_BIN", executable);
  try {
    const tracker = selectedCommandTracker();
    await expect(tracker.checked(profile, "VM readiness", args))
      .rejects.toThrow(`command exited 2${diagnostic ? ` (${diagnostic})` : ""};`);
    expect(tracker.commands[0]?.diagnostic).toBe(diagnostic);
    expect(JSON.stringify(tracker.commands)).not.toContain("PRIVATE");
    expect(JSON.stringify(tracker.commands)).not.toContain(stderr.trim());
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

const fixtureTarget = { kind: "opencode-setup" as const, name: profile.workspace, id: "11111111-1111-4111-8111-111111111111" };
it("durably retains only exact owned fixture stderr before caller cleanup, with bounded private receipts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-private-failure-")), executable = path.join(root, "dim"), file = path.join(root, "diagnostics.jsonl");
  const stderr = "x".repeat(20_000) + "npm error code ECONNRESET\nactual inner failure";
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write("DO_NOT_CAPTURE_STDOUT");process.stderr.write(${JSON.stringify(stderr)});process.exit(1);\n`, { mode: 0o700 });
  vi.stubEnv("DIM_BIN", executable);
  try {
    const tracker = selectedCommandTracker(undefined, fixtureFailureWriter(file));
    await expect(tracker.checked(profile, "other command", ["tools", "status", profile.workspace])).rejects.toThrow("command exited 1");
    expect(await readFile(file, "utf8")).toBe("");
    await expect(tracker.checked(profile, "owned workspace OpenCode setup", ["tools", "setup", profile.workspace, "opencode"], 120_000, fixtureTarget)).rejects.toThrow("command exited 1");
    const receipt = JSON.parse(await readFile(file, "utf8"));
    expect(receipt).toMatchObject({ owned: { name: profile.workspace, id: fixtureTarget.id }, exitCode: 1, stderrBytes: Buffer.byteLength(stderr), truncated: true });
    expect(Buffer.byteLength(receipt.stderr)).toBe(16 * 1024);
    expect(receipt.stderr).toContain("actual inner failure");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(tracker.commands)).not.toContain("actual inner failure");
    expect(await readFile(file, "utf8")).not.toContain("DO_NOT_CAPTURE_STDOUT");
    expect(tracker.commands[1]?.failureReceipt).toMatchObject({ path: "diagnostics.jsonl", record: 1 });
    await expect(tracker.checked(profile, "wrong target", ["tools", "status"], 120_000, fixtureTarget)).rejects.toThrow("operation mismatch");
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
    const vm = { kind: "auxiliary-readiness" as const, name: "dim-smoke-vm-owned", id: fixtureTarget.id };
    await expect(tracker.checked(profile, "auxiliary VM readiness", ["vm", "start", vm.name, "--expect-id", vm.id], 120_000, vm)).rejects.toThrow("command exited 1");
    expect(JSON.parse((await readFile(file, "utf8")).trim().split("\n")[1]!)).toMatchObject({ kind: "auxiliary-readiness", owned: { name: vm.name, id: vm.id } });
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
it("refuses existing, linked or replaced receipts and excess fixture failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-private-receipt-")), file = path.join(root, "diagnostics.jsonl"), other = path.join(root, "other");
  try {
    const write = fixtureFailureWriter(file), failure = { exitCode: 2, stdout: "", stderr: "VM inner failure" };
    expect(() => fixtureFailureWriter(file)).toThrow();
    for (let index = 0; index < 4; index++) write(fixtureTarget, failure);
    expect(() => write(fixtureTarget, failure)).toThrow("count exceeded");
    await writeFile(other, "untouched"); await rm(file); await symlink(other, file);
    expect(() => fixtureFailureWriter(file)).toThrow();
    const guarded = path.join(root, "guarded"), sink = fixtureFailureWriter(guarded);
    await rm(guarded); await symlink(other, guarded);
    expect(() => sink(fixtureTarget, failure)).toThrow();
    expect(await readFile(other, "utf8")).toBe("untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("preserves the primary exit and VM diagnostic when private capture fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-capture-failed-")), executable = path.join(root, "dim");
  await writeFile(executable, `#!${process.execPath}\nprocess.stderr.write("dim-host: VM guest Docker readiness failed: Incus exit 1: concrete cause\\n");process.exit(2);\n`, { mode: 0o700 });
  vi.stubEnv("DIM_BIN", executable);
  try {
    const tracker = selectedCommandTracker(undefined, () => { throw new Error("private sink failed"); });
    const vm = { kind: "auxiliary-readiness" as const, name: "dim-smoke-vm-owned", id: fixtureTarget.id };
    await expect(tracker.checked(profile, "auxiliary VM readiness", ["vm", "start", vm.name, "--expect-id", vm.id], 120_000, vm)).rejects.toThrow("command exited 2 (vm-docker-probe-failed); private diagnostic capture unavailable");
    expect(tracker.commands[0]).toMatchObject({ exitCode: 2, diagnostic: "vm-docker-probe-failed", failureReceiptUnavailable: true });
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
