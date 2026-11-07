import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../../../scripts/checks/lib/check-output.bash");

describe("check command output", () => {
  it("uses a real monotonic Node clock when proc uptime cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-check-clock-"));
    try {
      // A real Linux proc read at offset zero returns EIO, including outside Sysbox.
      const unreadableHelper = join(root, "unreadable-uptime.bash");
      await writeFile(unreadableHelper, (await readFile(helper, "utf8")).replace("</proc/uptime", "</proc/self/mem"));
      const before = Number(process.hrtime.bigint() / 1_000_000_000n);
      const result = spawnSync("bash", ["-euc", `
        source "$1"
        check_output_init "$2"
        trap check_output_stop EXIT
        check_output_run fixture bash -c 'printf "clock-fallback-output\\n"'
      `, "_", unreadableHelper, root], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const [directory] = (await readdir(root)).filter((name) => name.startsWith("run."));
      const stages = (await readFile(join(root, directory!, "stages.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(stages[0]!["monotonicSeconds"]).toEqual(expect.any(Number));
      expect(stages[0]!["monotonicSeconds"]).toBeGreaterThanOrEqual(before);
      expect(stages[1]!["monotonicSeconds"]).toBeLessThanOrEqual(Number(process.hrtime.bigint() / 1_000_000_000n));
      expect(stages[1]!["monotonicSeconds"]).toBeGreaterThanOrEqual(Number(stages[0]!["monotonicSeconds"]));
      expect(stages[1]!["elapsedSeconds"]).toBeGreaterThanOrEqual(0);
      expect(await readFile(join(root, directory!, "01-fixture.log"), "utf8")).toBe("clock-fallback-output\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains a real failure and private full log when neither timing source exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-check-clock-"));
    try {
      const unreadableHelper = join(root, "unreadable-uptime.bash"), bin = join(root, "bin");
      await writeFile(unreadableHelper, (await readFile(helper, "utf8")).replace("</proc/uptime", "</proc/self/mem"));
      await mkdir(bin);
      for (const name of ["mkdir", "mktemp", "date", "sleep", "tail"]) await symlink(`/usr/bin/${name}`, join(bin, name));
      const result = spawnSync("/bin/bash", ["-euc", `
        source "$1"
        check_output_init "$2"
        trap check_output_stop EXIT
        check_output_run fixture /bin/bash -c 'printf "unavailable-clock-failure\\n"; exit 23'
      `, "_", unreadableHelper, root], { encoding: "utf8", env: { ...process.env, PATH: bin } });
      expect(result.status, result.stderr).toBe(23);
      expect(result.stderr).toContain("FAIL fixture exit=23");
      const [directory] = (await readdir(root)).filter((name) => name.startsWith("run."));
      const stages = (await readFile(join(root, directory!, "stages.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(stages[0]).toMatchObject({ monotonicSeconds: null });
      expect(stages[1]).toMatchObject({ monotonicSeconds: null, elapsedSeconds: null, exitCode: 23 });
      const log = join(root, directory!, "01-fixture.log");
      expect(await readFile(log, "utf8")).toBe("unavailable-clock-failure\n");
      expect((await stat(log)).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not switch clock origins when its selected source later fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-check-clock-"));
    try {
      const result = spawnSync("bash", ["-euc", `
        source "$1"
        fixture_clock_marker="$2/clock-failed"
        check_output_read_uptime() { [[ ! -e "$fixture_clock_marker" ]] && printf '100'; }
        check_output_init "$2"
        [[ "$CHECK_OUTPUT_CLOCK" == proc ]]
        trap check_output_stop EXIT
        check_output_run fixture touch "$2/clock-failed"
      `, "_", helper, root], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const [directory] = (await readdir(root)).filter((name) => name.startsWith("run."));
      const stages = (await readFile(join(root, directory!, "stages.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(stages[0]).toMatchObject({ monotonicSeconds: 100 });
      expect(stages[1]).toMatchObject({ monotonicSeconds: null, elapsedSeconds: null, exitCode: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("keeps successful output in a private log (verbose=%s)", async (verbose) => {
    const root = await mkdtemp(join(tmpdir(), "dim-check-output-"));
    try {
      const result = spawnSync("bash", ["-euc", `
        source "$1"
        check_output_init "$2"
        trap check_output_stop EXIT
        check_output_run fixture bash -c 'printf "successful-output\\n"; printf "diagnostic\\n" >&2; test "$(umask)" = "$1"' _ "${process.umask().toString(8).padStart(4, "0")}"
      `, "_", helper, root], { encoding: "utf8", env: { ...process.env, DIM_CHECK_VERBOSE: verbose ? "1" : "0" } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.includes("successful-output")).toBe(verbose);
      const [directory] = await readdir(root);
      const log = join(root, directory!, "01-fixture.log");
      expect(await readFile(log, "utf8")).toBe("successful-output\ndiagnostic\n");
      expect((await stat(log)).mode & 0o777).toBe(0o600);
      const stages = (await readFile(join(root, directory!, "stages.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(stages[0]).toMatchObject({ stage: "fixture", event: "start", utc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), monotonicSeconds: expect.any(Number) });
      expect(stages[1]).toMatchObject({ stage: "fixture", event: "finish", exitCode: 0, elapsedSeconds: expect.any(Number) });
      expect(Number(stages[1]!["monotonicSeconds"])).toBeGreaterThanOrEqual(Number(stages[0]!["monotonicSeconds"]));
      expect((await stat(join(root, directory!, "stages.jsonl"))).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains a failed command's exit status, bounded diagnostics and full output", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-check-output-"));
    try {
      const result = spawnSync("bash", ["-euc", `
        source "$1"
        check_output_init "$2"
        trap check_output_stop EXIT
        check_output_run fixture bash -c 'for ((i=0;i<300;i++)); do printf "detail-%s\\n" "$i"; done; printf "failure-marker\\n" >&2; exit 23'
        printf 'should-not-run\\n'
      `, "_", helper, root], { encoding: "utf8" });
      expect(result.status).toBe(23);
      expect(result.stdout).not.toContain("should-not-run");
      expect(result.stderr).toContain("FAIL fixture exit=23");
      expect(result.stderr).toContain("failure-marker");
      expect(result.stderr).not.toContain("detail-0\n");
      const [directory] = await readdir(root);
      const log = await readFile(join(root, directory!, "01-fixture.log"), "utf8");
      expect(log).toContain("detail-0\n");
      expect(log).toContain("failure-marker");
      const stages = (await readFile(join(root, directory!, "stages.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(stages.at(-1)).toMatchObject({ stage: "fixture", event: "finish", exitCode: 23 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
