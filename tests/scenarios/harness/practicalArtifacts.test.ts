import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportPracticalArtifacts, redactPracticalLog } from "../../../scripts/ci/practical-artifacts.ts";
it("exports explicit failure diagnostics while excluding operator state and redacting credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-artifact-test-"));
  try {
    const evidence = join(root, "private"), output = join(root, "artifacts"); await mkdir(evidence); await mkdir(output);
    await mkdir(join(evidence, "stages/run.test"), { recursive: true });
    await writeFile(join(evidence, "source.json"), JSON.stringify({ sourceSha: "a".repeat(40) }));
    await writeFile(join(evidence, "operator.json"), '{"password":"DO-NOT-EXPORT"}');
    await writeFile(join(evidence, "login-key"), "PRIVATE FILE");
    await writeFile(join(evidence, "stages/run.test/02-host-build-images-artifacts.log"), 'Error: meaningful failure\npassword="secret words" token=opaque\nAuthorization: Bearer token.bytes\n');
    await exportPracticalArtifacts(evidence, output, 23);
    expect(await readdir(join(output, "practical"))).not.toContain("operator.json");
    expect(await readdir(join(output, "practical"))).not.toContain("login-key");
    const log = await readFile(join(output, "practical/stages/run.test/02-host-build-images-artifacts.log"), "utf8");
    expect(log).toContain("meaningful failure"); expect(log).not.toMatch(/secret words|opaque|token\.bytes/);
    const manifest = JSON.parse(await readFile(join(output, "practical/export.json"), "utf8"));
    expect(manifest.status).toBe("FAIL"); expect(manifest.exitCode).toBe(23); expect(manifest.entries).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("does not follow an allowlisted diagnostic symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-artifact-link-"));
  try { const evidence = join(root, "private"), output = join(root, "output"); await mkdir(evidence); await mkdir(output); await writeFile(join(root, "secret"), "not exported");
    await symlink(join(root, "secret"), join(evidence, "source.json")); await expect(exportPracticalArtifacts(evidence, output, 1)).rejects.toThrow("unsafe");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("redacts a private key block without suppressing surrounding errors", () => {
  expect(redactPracticalLog("before\n-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----\nafter")).toBe("before\n[REDACTED PRIVATE KEY]\nafter");
});
it("retains explicit baseline mode, observed clone identities and stage timings without exporting VM disks", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-baseline-artifacts-"));
  try {
    const evidence = join(root, "private"), output = join(root, "output"); await mkdir(evidence); await mkdir(output);
    await mkdir(join(evidence, "stages/run.cached"), { recursive: true });
    const files = { "input.txt": "installation-mode=dependency-baseline\n", "dependency-baseline.json": '{"recipeSha256":"reviewed"}',
      "clone-identities.json": '{"controlPlane":{"machine":"cp"},"host":{"machine":"host"}}', "qualification.json": '{"installationMode":"dependency-baseline"}',
      "stages/run.cached/stages.jsonl": '{"stage":"host-baseline-fresh-install","event":"finish","exitCode":0}\n',
      "stages/run.cached/02-host-baseline-fresh-install.log": "fresh source installation passed\n",
      "stages/run.cached/04-control-plane-install.log": "explicit foreground CP installation failed with its own exit\n",
      "stages/run.cached/05-host-installed-recipes.log": "installed recipe diagnostics\n" };
    for (const [name, content] of Object.entries(files)) await writeFile(join(evidence, name), content);
    await writeFile(join(evidence, "host.qcow2"), "NEVER-EXPORT-GUEST-DISK");
    await exportPracticalArtifacts(evidence, output, 0);
    for (const [name, content] of Object.entries(files)) {
      const exported = await readFile(join(output, "practical", name), "utf8");
      expect(name.endsWith(".json") ? JSON.parse(exported) : exported).toEqual(name.endsWith(".json") ? JSON.parse(content) : content);
    }
    expect(await readdir(join(output, "practical"))).not.toContain("host.qcow2");
  } finally { await rm(root, { recursive: true, force: true }); }
});
