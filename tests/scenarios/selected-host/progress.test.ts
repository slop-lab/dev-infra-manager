import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runCommand } from "../web-lifecycle/process.ts";
import { forwardSmokeProgress, smokeProgress } from "./progress.ts";

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
