import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { HostProfile } from "./config.js";
import { selectedCommandTracker } from "./selectedCommand.js";

it("retains failed command exit evidence without recording scripts, prompts or raw private output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-command-evidence-")), bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "dim"), `#!${process.execPath}\nprocess.stderr.write("PRIVATE_STDERR");process.exit(7);\n`, { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  const profile: HostProfile = { name: "fixture", workspace: "dim-smoke-test", source: "/private/repo", workspaceSourceSha: "a".repeat(40),
    expectedHostVersion: "0.10.0", requiredPlugins: [], ingress: "shared", sshPublicKey: "fixture", llm: { configFile: "/private/gateway.json", project: "smoke", route: "default" } };
  try {
    const tracker = selectedCommandTracker();
    await expect(tracker.checked(profile, "scoped command", ["exec", "dim-smoke-test", "--", "node", "-e", "PRIVATE_SCRIPT"]))
      .rejects.toThrow("command exited 7");
    expect(tracker.commands[0]).toMatchObject({ step: "scoped command", exitCode: 7, surface: ["dim", "--host", "fixture", "exec", "<owned-workspace>", "--", "node"] });
    expect(JSON.stringify(tracker.commands)).not.toContain("PRIVATE");
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
