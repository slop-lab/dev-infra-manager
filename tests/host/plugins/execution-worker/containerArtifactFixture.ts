import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sysboxBackend } from "../../../../packages/host/plugins/execution-worker/src/backends/sysbox.js";
import { captureExecutionArtifacts } from "../../../../packages/host/plugins/execution-worker/src/artifacts.js";
import { assignment, grant } from "../../../contracts/ci/executionFixture.js";
import { ExecutorRunner } from "./sysboxFixture.js";
import { artifactTar } from "./artifactTarFixture.js";

export async function containerArtifactFixture(runner = new ExecutorRunner()) {
  const root = await mkdtemp(join(tmpdir(), "dim-artifact-handoff-")), directory = join(root, "workspace/.dim-ci-artifacts");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('{"nonce":"fffccb07-6199-4772-b225-0556b8b61166"}\n'), path = join(directory, "private.json");
  await writeFile(path, bytes, { mode: 0o600 });
  runner.archive = artifactTar("private.json", bytes);
  const nonce = randomUUID();
  const run = () => sysboxBackend.run({ root, runner, artifactNonce: nonce, grant: grant(assignment()), signal: new AbortController().signal,
    acquireCandidate: async ({ scriptFile }) => { await writeFile(scriptFile, "true\n"); } });
  async function capture(selectedNonce = nonce) {
    const completed = await run();
    if (completed.artifactSource === undefined) throw new Error("backend handoff missing");
    const manifest = await captureExecutionArtifacts({ root, pending: join(root, "pending"), result: completed, artifactSource: completed.artifactSource, artifactNonce: selectedNonce });
    return { completed, manifest };
  }
  return { root, directory, path, bytes, runner, nonce, run, capture };
}
