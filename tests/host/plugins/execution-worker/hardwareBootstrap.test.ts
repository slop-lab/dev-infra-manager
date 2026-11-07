import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
it.each([100, 23])("keeps package setup under the exit trap and returns bootstrap failure %s", async failure => {
  const source = await readFile(new URL("../../../../packages/host/plugins/execution-worker/src/ubuntu-hardware-runner-assets/guest-run.bash", import.meta.url), "utf8");
  const supervisor = await readFile(new URL("../../../../packages/host/plugins/execution-worker/src/ubuntu-hardware-runner-assets/supervisor.ts", import.meta.url), "utf8");
  expect(source).toContain("chmod 0755 /run/dim");
  expect(source).toContain("runuser -u dim -- test -x /run/dim/run-job");
  expect(source).not.toContain("https://");
  expect(supervisor).toContain("package_update: false"); expect(supervisor).not.toContain("packages:");
  expect(source.indexOf("trap finish EXIT")).toBeLessThan(source.indexOf("apt_status=100"));
  expect(source.indexOf("done </run/dim/job/config-targets")).toBeLessThan(source.indexOf("apt_status=100"));
  expect(source.indexOf("source /run/dim/job/job-environment")).toBeLessThan(source.indexOf("apt_status=100"));
  const root = await mkdtemp(join(tmpdir(), "dim-apt-bootstrap-"));
  try {
    const body = source.slice(source.indexOf("apt_status=100"), source.indexOf("# A separate fixed-size disk"));
    const prefix = 'timeout() { printf "%s\\n" "$*" >>"$TRACE"; if [[ "${@: -1}" == update ]]; then return "$UPDATE_STATUS"; fi; return 23; }; sleep() { :; };\n';
    const result = spawnSync("bash", ["-ec", prefix + body], { env: { PATH: process.env.PATH, TRACE: join(root, "trace"), UPDATE_STATUS: failure === 100 ? "100" : "0" }, encoding: "utf8" });
    expect(result.status).toBe(failure);
    const trace = await readFile(join(root, "trace"), "utf8");
    expect(trace.match(/ update/g)).toHaveLength(failure === 100 ? 3 : 1);
    expect(trace.includes("install -y --no-install-recommends")).toBe(failure === 23);
    expect(trace).toContain("Acquire::By-Hash=force"); expect(trace).toContain("APT::Update::Error-Mode=any");
  } finally { await rm(root, { recursive: true, force: true }); }
});
