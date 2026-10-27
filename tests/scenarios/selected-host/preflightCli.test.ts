import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const script = new URL("../../../scripts/checks/selected-host-usability-smoke.ts", import.meta.url).pathname;
it.each([false, "empty"] as const)("rejects exit-zero doctor output with failed or absent checks (%s) through the offline fixture CLI", async (doctor) => {
  const root = await mkdtemp(join(tmpdir(), "dim-preflight-cli-")), bin = join(root, "bin");
  try {
    await mkdir(bin);
    const checks = doctor === "empty" ? [] : [{ name: "runtime", ok: false, detail: "PRIVATE_DIAGNOSTIC" }];
    await writeFile(join(bin, "dim"), `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]!=='--host'||args[1]!=='fixture')process.exit(99);const command=args[2];if(command==='--version')console.log('0.10.0');else if(command==='doctor')console.log(${JSON.stringify(JSON.stringify(checks))});else if(command==='plugins')console.log(JSON.stringify(['agent-tools','host-llm-router','external-urls','native-git','kvm'].map(name=>({name}))));else if(command==='list')console.log('[]');else process.exit(98);\n`, { mode: 0o700 });
    const config = join(root, "targets.json");
    await writeFile(config, JSON.stringify({ schemaVersion: 1, installedSourceSha: "a".repeat(40), hosts: [{
      name: "fixture", workspace: "dim-smoke-fixture", source: "dim://dim-smoke-fixture", workspaceSourceSha: "b".repeat(40), expectedHostVersion: "0.10.0",
      requiredPlugins: ["agent-tools", "host-llm-router", "external-urls", "native-git"], ingress: "shared",
      sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureSelectedHostKey fixture@example.invalid",
      llm: { configFile: join(root, "not-read.json"), project: "fixture", route: "default" },
    }] }), { mode: 0o600 });
    const child = spawn(process.execPath, ["--import", "tsx", script, "--config", config, "--host", "fixture", "--preflight-only", "--json"], {
      cwd: new URL("../../", import.meta.url).pathname, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root }, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    expect(code).toBe(2); expect(stderr).toBe(""); expect(stdout).not.toContain("PRIVATE_DIAGNOSTIC");
    expect(JSON.parse(stdout)).toMatchObject({ outcome: "unavailable", completion: "not-assessed", preflights: [{ host: "fixture", ok: false }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
