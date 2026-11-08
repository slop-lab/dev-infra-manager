import { expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCommand } from "../web-lifecycle/process.ts";
import { persistPracticalSmokeReport } from "../selected-host/ci/smokeReport.ts";
import { exportPracticalArtifacts } from "../../../scripts/ci/practical-artifacts.ts";

it.each([{ outcome: "failed", exitCode: 23 }, { outcome: "incomplete", exitCode: 2 }])("preserves the nonpassing $outcome report before rejecting exit $exitCode", async ({ outcome, exitCode }) => {
  const root = await mkdtemp(join(tmpdir(), "dim-smoke-report-"));
  try {
    const evidence = join(root, "evidence"), output = join(root, "output"); await mkdir(evidence); await mkdir(output);
    const report = { outcome, results: ["local", "practical-ssh"].map(host => ({ host, commands: Array.from({ length: 200 }, (_, n) => ({ step: `owned step ${n}`, exitCode: 0 })), lanes: [{ name: "owned-opencode-session-monitor", status: outcome === "incomplete" ? "BLOCKED" : "FAIL", reason: `final-${host}` }] })) };
    const child = await runCommand(process.execPath, ["-e", 'process.stdout.write(process.argv[1]);process.stderr.write("DO-NOT-RETAIN-RAW");process.exitCode=Number(process.argv[2])', JSON.stringify(report), String(exitCode)], { acceptFailure: true });
    expect(child.stdout.length).toBeGreaterThan(10_000);
    await expect(persistPracticalSmokeReport(join(evidence, "selected-host-report.json"), child)).rejects.toThrow(`exit ${exitCode}`);
    expect((await stat(join(evidence, "selected-host-report.json"))).mode & 0o777).toBe(0o600);
    await exportPracticalArtifacts(evidence, output, child.exitCode);
    const exported = await readFile(join(output, "practical/selected-host-report.json"), "utf8");
    expect(JSON.parse(exported)).toEqual(report); expect(exported).not.toContain("DO-NOT-RETAIN-RAW");
    const manifest = JSON.parse(await readFile(join(output, "practical/export.json"), "utf8"));
    expect(manifest.status).toBe("FAIL"); expect(manifest.exitCode).toBe(exitCode);
    expect(manifest.entries).toEqual([expect.objectContaining({ path: "selected-host-report.json", truncated: false })]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not turn failed report collection into recipe success or hide an original failure", async () => {
  const helper = resolve(import.meta.dirname, "../../../scripts/checks/lib/examples-separated-vms.bash");
  const { stdout } = await promisify(execFile)("bash", ["-c", `set -euo pipefail
source "$1"
BOOTSTRAP_SCP=(scp) BOOTSTRAP_EVIDENCE_ROOT=/private/evidence
copy_status=0
timeout() { printf 'copy:%s\\n' "\${*: -2}"; return "$copy_status"; }
for pair in '23 0' '23 7' '0 7' '0 0'; do
  read -r recipe copy_status <<<"$pair"
  result=0; examples_collect_smoke_report "$recipe" || result=$?
  printf 'result:%s\\n' "$result"
done
`, "test", helper]);
  expect(stdout.match(/result:\d+/g)).toEqual(["result:23", "result:23", "result:7", "result:0"]);
  expect(stdout.match(/copy:/g)).toHaveLength(8);
  expect(stdout).toContain("/home/dim/dim/selected-command-diagnostics.jsonl /private/evidence/selected-command-diagnostics.jsonl");
  expect(stdout).toContain("/home/dim/dim/selected-host-report.json /private/evidence/selected-host-report.json");
});
