import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { HostProfile } from "./config.js";
import { selectedCommandTracker } from "./selectedCommand.js";

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
  { args: ["vm", "start", "owned"], stderr: "dim-host: VM guest agent did not become ready; verify the reviewed image and Incus agent payload before retrying\n", diagnostic: "vm-agent-not-ready" },
  { args: ["vm", "start", "owned"], stderr: "dim: VM guest readiness failed: PRIVATE_INCUS_DETAILS\n", diagnostic: "vm-agent-probe-failed" },
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
