import { constants } from "node:fs";
import { link, lstat, open, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { executionWorkerCapacitySpecSchema, executionWorkerConfigSchema } from "@slop-lab/dim-contracts-ci/worker";
import { createExecutionOperatorClient } from "@slop-lab/dim-service-client-execution";
import { UserError } from "@slop-lab/dim-host-core/workspace";

type WorkerPublicationInput = {
  readonly connectionFile: string; readonly specFile: string; readonly outputFile: string;
};
export async function enrollExecutionWorker(input: WorkerPublicationInput): Promise<void> {
  await publishExecutionWorker(input, "enroll");
}
export async function exportExecutionWorker(input: WorkerPublicationInput): Promise<void> {
  await publishExecutionWorker(input, "export");
}
async function publishExecutionWorker(input: WorkerPublicationInput, operation: "enroll" | "export"): Promise<void> {
  if (![input.connectionFile, input.specFile, input.outputFile].every(isAbsolute)) {
    throw new UserError("execution worker paths must be absolute");
  }
  const specHandle = await open(input.specFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let spec;
  try {
    const metadata = await specHandle.stat();
    if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600 || metadata.size > 64 * 1024) throw new UserError("execution capacity spec must be an owned mode-0600 file");
    spec = executionWorkerCapacitySpecSchema.parse(JSON.parse(await specHandle.readFile("utf8")));
  } finally { await specHandle.close(); }
  try { await lstat(input.outputFile); throw new UserError("execution worker output already exists"); }
  catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error;
  }
  const temporary = join(dirname(input.outputFile), `.${basename(input.outputFile)}.${randomUUID()}.tmp`);
  const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let accepted = false;
  try {
    const operator = await createExecutionOperatorClient(input.connectionFile);
    const secret = operation === "enroll"
      ? await operator.enroll({ schemaVersion: 1, workerId: spec.workerId, slots: spec.slots })
      : await operator.exportWorker(spec.workerId);
    accepted = operation === "enroll";
    if (!isDeepStrictEqual(secret.slots, spec.slots)) throw new UserError("enrolled worker capacity differs from the trusted export spec");
    const worker = executionWorkerConfigSchema.parse({ schemaVersion: 1, workerId: spec.workerId,
      generationId: secret.generationId, endpoint: operator.endpoint, token: secret.token, stateDirectory: spec.stateDirectory,
      slots: spec.slots.map((slot) => "runtime" in slot ? { id: slot.id, runtime: slot.runtime } : slot),
      ...(spec.gitExecutable === undefined ? {} : { gitExecutable: spec.gitExecutable }),
      ...(spec.nativeGitEndpoint === undefined ? {} : { nativeGitEndpoint: spec.nativeGitEndpoint }) });
    await output.writeFile(`${JSON.stringify(worker, null, 2)}\n`, "utf8"); await output.sync();
    await link(temporary, input.outputFile);
  }
  catch (error) {
    if (accepted) throw new UserError("worker enrollment was accepted but private config publication failed; export the enrolled worker to a new output path");
    throw error;
  }
  finally { await output.close(); await rm(temporary, { force: true }); }
}
