import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareSmokeProfile } from "./profilePreparation.js";

const sourceSha = "a".repeat(40), version = "0.10.0-local-reviewed";
const artifacts = { schemaVersion: 1, packages: ["@slop-lab/dim-host-core", "@slop-lab/dim-cli"].map((name) => ({ name, version, file: `${name.split("/").at(-1)}.tgz`, requires: {} })) };
const host = { name: "disposable-host", source: "/srv/reviewed/source", ingress: "shared", llm: { configFile: "/private/gateway.json", project: "smoke", route: "default" } };
const sshPublicKey = `ssh-ed25519 ${Buffer.alloc(51, 1).toString("base64")} smoke`;

it("derives source, versions, names and required capabilities while retaining explicit host bindings", () => {
  const profile = prepareSmokeProfile({ bindings: { schemaVersion: 1, hosts: [host] }, artifacts, sourceSha, sshPublicKey });
  expect(profile).toMatchObject({ schemaVersion: 1, installedSourceSha: sourceSha, hosts: [{ ...host, expectedHostVersion: version,
    workspaceSourceSha: sourceSha, sshPublicKey, requiredPlugins: ["agent-tools", "host-llm-router", "external-urls"] }] });
  expect(profile.hosts[0]?.workspace).toMatch(/^dim-smoke-/);
});

it("rejects privileged or derived host fields rather than silently overriding them", () => {
  expect(() => prepareSmokeProfile({ bindings: { schemaVersion: 1, hosts: [{ ...host, expectedHostVersion: "forged" }] }, artifacts, sourceSha, sshPublicKey })).toThrow();
});

it("derives the VM capability requirement only from an explicit reviewed image binding", () => {
  const profile = prepareSmokeProfile({ bindings: { schemaVersion: 1, hosts: [{ ...host, vm: { image: "b".repeat(64) } }] }, artifacts, sourceSha, sshPublicKey });
  expect(profile.hosts[0]?.requiredPlugins).toContain("vm");
  expect(profile.hosts[0]?.vm?.image).toBe("b".repeat(64));
});

it("executes the public VM recipe and refuses to count preflight as acceptance", async () => {
  const root = new URL("../../../", import.meta.url).pathname;
  await expect(promisify(execFile)(process.execPath, ["scripts/examples/run.ts", "examples/features/ordinary-workspace", "verify-vm"], {
    cwd: root, env: { ...process.env, DIM_SMOKE_PREFLIGHT_ONLY: "1" }
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("VM acceptance cannot use preflight-only mode") });
});
