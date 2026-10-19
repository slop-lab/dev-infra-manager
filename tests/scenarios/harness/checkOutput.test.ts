import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../../../scripts/checks/lib/check-output.bash");

describe("check command output", () => {
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
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
