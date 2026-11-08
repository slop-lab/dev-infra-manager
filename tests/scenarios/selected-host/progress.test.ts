import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runCommand } from "../web-lifecycle/process.ts";
import { forwardSmokeProgress, readPracticalProgress, smokeProgress } from "./progress.ts";

it("streams only structured progress before the child completes while stdout remains one JSON report", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-live-progress-")), release = join(root, "release");
  try {
    const lines: string[] = [], progress = smokeProgress(line => { lines.push(line); });
    progress.phase("local", "owned workspace OpenCode setup");
    progress.command("local", { step: "owned workspace OpenCode setup", surface: ["private-not-forwarded"], durationMilliseconds: 123_456, exitCode: 0 });
    let finished = false, observedBeforeExit = false, releaseWrite: Promise<void> | undefined;
    const forwarded: string[] = [], forward = forwardSmokeProgress(line => {
      forwarded.push(line); observedBeforeExit = !finished;
      releaseWrite ??= writeFile(release, "ready");
    });
    const output = await runCommand(process.execPath, ["-e", `
      const fs=require('node:fs');process.stderr.write('PRIVATE_AUTH_DIAGNOSTIC\\n');
      const lines=JSON.parse(process.argv[1]);for(const line of lines){process.stderr.write(line.slice(0,17));process.stderr.write(line.slice(17));}
      const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);process.stdout.write(JSON.stringify({outcome:'passed'}));}},10);
    `, JSON.stringify(lines), release], { timeoutMs: 5_000, onStderr: forward });
    finished = true; await releaseWrite;
    expect(observedBeforeExit).toBe(true); expect(forwarded).toEqual(lines);
    expect(forwarded.join("")).not.toContain("PRIVATE");
    expect(output.stderr).toContain("PRIVATE_AUTH_DIAGNOSTIC");
    expect(JSON.parse(output.stdout)).toEqual({ outcome: "passed" });
    const events = lines.map(line => JSON.parse(line.slice("[selected-host] ".length)));
    expect(events[0]).toMatchObject({ phase: "progress", host: "local", step: "owned workspace OpenCode setup", elapsedMilliseconds: expect.any(Number), utc: expect.any(String) });
    expect(events[1]).toMatchObject({ phase: "command-complete", durationMilliseconds: 123_456, exitCode: 0 });
    expect(events[1].elapsedMilliseconds).toBeGreaterThanOrEqual(events[0].elapsedMilliseconds);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("drops malformed, oversized and extra-field stderr records without losing the next valid progress record", () => {
  const lines: string[] = [], valid: string[] = [];
  smokeProgress(line => { valid.push(line); }).phase("local", "auxiliary VM readiness");
  const forward = forwardSmokeProgress(line => { lines.push(line); });
  forward("PRIVATE\n[selected-host] invalid\n" + "x".repeat(2049));
  forward("still-private\n");
  const event = JSON.parse(valid[0]!.slice("[selected-host] ".length));
  forward(`[selected-host] ${JSON.stringify({ ...event, stderr: "PRIVATE" })}\n`);
  forward(valid[0]!.slice(0, 13)); forward(valid[0]!.slice(13));
  expect(lines).toEqual(valid);
});

it("reads bounded incremental private logs, carries partial records and accepts only fixed preparation labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-progress-reader-")), log = join(root, "stage.log");
  const valid = "[examples-timing] host-source-build finish utc=2026-11-08T14:00:00Z elapsedSeconds=null exit=23\n";
  try {
    await writeFile(log, "PRIVATE".repeat(200_000) + "\n" + valid.slice(0, 31), { mode: 0o600 });
    const first = readPracticalProgress(log, 0);
    expect(first.lines).toEqual([]);
    await appendFile(log, valid.slice(31) + "[examples-timing] arbitrary-private start utc=2026-11-08T14:00:00Z\n[examples-timing] host-source-build finish utc=2026-11-08T14:00:00Z elapsedSeconds=1 exit=999\n");
    const second = readPracticalProgress(log, first.offset);
    expect(second.lines).toEqual([valid.trim()]);
    expect(readPracticalProgress(log, second.offset).lines).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("forwards safe records through the real shell heartbeat before child release and flushes without replacing exit23", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-progress-heartbeat-")), release = join(root, "release");
  const helper = new URL("../../../scripts/checks/lib/check-output.bash", import.meta.url).pathname;
  const reader = new URL("../../../scripts/checks/lib/examples-separated-vms.bash", import.meta.url).pathname;
  const lines: string[] = []; smokeProgress(line => { lines.push(line); }).phase("local", "auxiliary VM readiness");
  try {
    let released = false, releaseWrite: Promise<void> | undefined;
    const output = await runCommand("bash", ["-euc", `
      source "$1"
      source "$4"
      script_dir="$(cd -- "$(dirname -- "$1")/.." && pwd)"
      export PATH="$(dirname -- "$3"):$PATH"
      check_output_init "$2"
      trap check_output_stop EXIT
      # Accelerate only the presentation heartbeat in this owned fixture.
      sleep() { [[ "$1" == 30 ]]; command sleep 0.02; }
      check_output_run --progress-reader examples_read_progress fixture "$3" -e '
        const fs=require("node:fs");process.stdout.write("PRIVATE_RAW_NOISE\\n"+"quiet fixture output\\n".repeat(200)+process.argv[1]);
        const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);process.stdout.write("[examples-timing] host-source-build finish utc=2026-11-08T14:00:00Z elapsedSeconds=2 exit=23\\n");process.exitCode=23;}},10);
      ' "$5" "$6"
    `, "fixture", helper, root, process.execPath, reader, lines[0]!, release], { acceptFailure: true, timeoutMs: 5_000, onStderr: chunk => {
      if (chunk.includes("[selected-host] ")) { released = true; releaseWrite ??= writeFile(release, "observed"); }
    } });
    await releaseWrite;
    expect(released).toBe(true); expect(output.exitCode).toBe(23);
    const live = output.stderr.split("[check] FAIL")[0]!;
    expect(live).toContain(lines[0]!.trim()); expect(live).not.toContain("PRIVATE_RAW_NOISE");
    expect(live).toContain("[examples-timing] host-source-build finish");
    const directory = (await readdir(root)).find(name => name.startsWith("run."))!;
    expect(await readFile(join(root, directory, "01-fixture.log"), "utf8")).toContain("PRIVATE_RAW_NOISE");
    expect((await readdir(join(root, directory))).some(name => name.endsWith(".progress-offset"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([0, 23])("keeps command exit%s and quiet success when the optional presentation reader fails", async exit => {
  const root = await mkdtemp(join(tmpdir(), "dim-progress-reader-failure-"));
  const helper = new URL("../../../scripts/checks/lib/check-output.bash", import.meta.url).pathname;
  try {
    const result = await runCommand("bash", ["-euc", `source "$1"; check_output_init "$2"; trap check_output_stop EXIT
      reader() { printf PRIVATE_READER_ERROR >&2; return 7; }
      check_output_run --progress-reader reader fixture bash -c 'printf private-command-output; exit "$1"' fixture "$3"
    `, "fixture", helper, root, String(exit)], { acceptFailure: true });
    expect(result.exitCode).toBe(exit); expect(result.stderr).not.toContain("PRIVATE_READER_ERROR");
    if (exit === 0) expect(result.stdout + result.stderr).not.toContain("private-command-output");
  } finally { await rm(root, { recursive: true, force: true }); }
});
