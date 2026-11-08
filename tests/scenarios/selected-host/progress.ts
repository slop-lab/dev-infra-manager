import type { CommandEvidence } from "./selectedCommand.ts";
import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const prefix = "[selected-host] ";
type Phase = "progress" | "pass" | "incomplete" | "command-complete";
type Progress = { utc: string; elapsedMilliseconds: number; host: string; phase: Phase; step: string; durationMilliseconds?: number; exitCode?: number | null };

/** Only fixture-owned labels and numeric timing; never argv, output or credentials. */
export function smokeProgress(write: (line: string) => void = line => { process.stderr.write(line); }) {
  const started = performance.now();
  const emit = (host: string, phase: Phase, step: string, command?: CommandEvidence): void => {
    const event: Progress = { utc: new Date().toISOString(), elapsedMilliseconds: Math.ceil(performance.now() - started), host, phase, step,
      ...(command === undefined ? {} : { durationMilliseconds: command.durationMilliseconds, exitCode: command.exitCode }) };
    write(`${prefix}${JSON.stringify(event)}\n`);
  };
  return { phase: (host: string, step: string, phase: Phase = "progress") => emit(host, phase, step),
    command: (host: string, command: CommandEvidence) => emit(host, "command-complete", command.step, command) };
}

/** Forward only the bounded structured progress channel, not arbitrary child stderr. */
export function forwardSmokeProgress(write: (line: string) => void = line => { process.stderr.write(line); }): (chunk: string) => void {
  let pending = "", dropping = false;
  return chunk => {
    for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const ended = part.endsWith("\n");
      if (pending.length + part.length > 2048) { pending = ""; dropping = true; }
      if (!dropping) pending += part;
      if (!ended) continue;
      if (!dropping && pending.startsWith(prefix)) {
        try {
          const event = JSON.parse(pending.slice(prefix.length)) as Progress;
          const keys = Object.keys(event);
          if (keys.every(key => ["utc", "elapsedMilliseconds", "host", "phase", "step", "durationMilliseconds", "exitCode"].includes(key))
            && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.utc)
            && Number.isSafeInteger(event.elapsedMilliseconds) && event.elapsedMilliseconds >= 0
            && /^[a-zA-Z0-9_-]{1,64}$/.test(event.host)
            && ["progress", "pass", "incomplete", "command-complete"].includes(event.phase)
            && typeof event.step === "string" && event.step.length > 0 && event.step.length <= 512 && !/[\r\n\t]/.test(event.step)
            && (event.durationMilliseconds === undefined || Number.isSafeInteger(event.durationMilliseconds) && event.durationMilliseconds >= 0)
            && (event.exitCode === undefined || event.exitCode === null || Number.isSafeInteger(event.exitCode))) write(`${prefix}${JSON.stringify(event)}\n`);
        } catch { /* Malformed/private stderr is retained only by the existing bounded command capture. */ }
      }
      pending = ""; dropping = false;
    }
  };
}

const preparationLabels = new Set(["host-cold-bootstrap", "host-source-install", "host-source-build", "host-service-images", "host-installer-checks", "host-current-pack", "host-operator-prepare", "host-service-prepare", "host-before-pack", "host-fixture-prepare", "host-guest-preparation"]);

/** Read only newly completed lines, bounded even when the private raw log is huge. */
export function readPracticalProgress(log: string, offset: number): { offset: number; lines: string[] } {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid progress offset");
  const fd = openSync(log, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || ![0, process.getuid?.()].includes(info.uid) || (info.mode & 0o022) !== 0
      || !Number.isSafeInteger(info.size) || offset > info.size) throw new Error("invalid private progress log");
    const start = Math.max(offset, info.size - 1024 * 1024), bytes = Buffer.alloc(info.size - start);
    const read = readSync(fd, bytes, 0, bytes.length, start), end = bytes.lastIndexOf(10, read - 1);
    if (read === 0 || end < 0) return { offset, lines: [] };
    const first = start === offset ? 0 : bytes.indexOf(10) + 1;
    const lines: string[] = [], forward = forwardSmokeProgress(line => { lines.push(line.trimEnd()); });
    for (const line of bytes.subarray(first, end + 1).toString("utf8").split("\n")) {
      if (line.length > 2048) continue;
      if (line.startsWith(prefix)) forward(`${line}\n`);
      else {
        const event = /^\[examples-timing\] ([a-z-]+) (start|finish) utc=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)(?: elapsedSeconds=(null|[0-9]+) exit=([0-9]{1,3}))?$/.exec(line);
        if (event && preparationLabels.has(event[1]!) && (event[2] === "start" ? event[4] === undefined : event[4] !== undefined && (event[4] === "null" || Number.isSafeInteger(Number(event[4]))) && Number(event[5]) <= 255)) lines.push(line);
      }
    }
    return { offset: start + end + 1, lines };
  } finally { closeSync(fd); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5 || process.argv[2] !== "--read-log") throw new Error("invalid progress reader arguments");
    const result = readPracticalProgress(process.argv[3]!, Number(process.argv[4]));
    process.stdout.write(`${result.offset}\n${result.lines.map(line => `${line}\n`).join("")}`);
  } catch { process.exitCode = 1; } // Presentation failure never exports raw diagnostics.
}
