import type { CommandEvidence } from "./selectedCommand.ts";

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
