import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sysboxBackend } from "../../../../packages/host/plugins/execution-worker/src/backends/sysbox.js";
import { openDisposableGit } from "../../../../packages/host/plugins/execution-worker/src/nativeGitCandidateProcess.js";
import { grant, assignment } from "../../../contracts/ci/executionFixture.js";
import { ExecutorRunner } from "./sysboxFixture.js";

export async function sysboxAcquisitionFailure(mode: "transport" | "timeout" | "cancel") {
  const root = await mkdtemp(join(tmpdir(), "dim-sysbox-acquisition-"));
  const controller = new AbortController(), runner = new ExecutorRunner();
  const secret = "PRIVATE_RESPONSE_HEADER_BODY_AND_PASSWORD";
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (mode === "cancel") controller.abort();
    if (mode === "transport") response.writeHead(503, { "x-private": secret }).end(secret);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture listener");
    const endpoint = `http://127.0.0.1:${address.port}/private-repository.git`;
    const timeoutMilliseconds = mode === "timeout" ? 1000 : 30_000;
    const result = await sysboxBackend.run({ root, runner, grant: grant(assignment()), signal: controller.signal,
      acquireCandidate: async ({ signal, diagnostics }) => {
        const git = await openDisposableGit({ executable: "/usr/bin/git", temporaryRoot: root, objectFormat: "sha1",
          username: "private-reader", password: secret, timeoutMilliseconds,
          ...(diagnostics === undefined ? {} : { diagnostics }) }, signal);
        try { await git.runAuthenticated(["fetch", "--depth=1", endpoint, "a".repeat(40)], 64 * 1024, signal); }
        finally { await git.close(); }
      }
    });
    const stderr = await readFile(join(root, "output", "stderr"));
    return { result, stderr, calls: runner.calls, requests, endpoint, secret, timeoutMilliseconds };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
