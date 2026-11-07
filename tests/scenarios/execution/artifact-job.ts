/** Real scheduler fixture: a failed job must still leave complete retrievable evidence. */
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const [option, value, ...extra] = process.argv.slice(2);
if (option !== "--exit-code" || !["0", "23"].includes(value ?? "") || extra.length !== 0) {
  throw new Error("Usage: node artifact-job.ts --exit-code 0|23");
}
const directory = process.env.DIM_ARTIFACTS_DIR;
if (!directory || !isAbsolute(directory)) throw new Error("DIM CI must provide an absolute DIM_ARTIFACTS_DIR");
await mkdir(directory, { recursive: true });
const marker = "DIM-CI-EVIDENCE-BEYOND-DIAGNOSTIC-PREFIX";
const stdout = `${"stdout fixture evidence\n".repeat(4600)}${marker}:stdout\n`;
const stderr = `${"stderr fixture evidence\n".repeat(3400)}${marker}:stderr\n`;
await Promise.all([
  writeFile(join(directory, "receipt.json"), `${JSON.stringify({ schemaVersion: 1, fixture: "scheduler-artifact-roundtrip", exitCode: Number(value), marker })}\n`),
  // A tiny deterministic binary download fixture, not a browser screenshot.
  writeFile(join(directory, "sample.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO8sAAAAASUVORK5CYII=", "base64")),
]);
await Promise.all([
  new Promise<void>((resolve, reject) => process.stdout.write(stdout, (error) => error ? reject(error) : resolve())),
  new Promise<void>((resolve, reject) => process.stderr.write(stderr, (error) => error ? reject(error) : resolve())),
]);
process.exitCode = Number(value);
