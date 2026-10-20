import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTracker, type ReviewTraceRuntime } from "@slop-lab/dim-review-tracing";

const image = "docker.io/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df";
const limits = { fileBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, requests: 128, executionMs: 15_000, stdoutBytes: 256 * 1024, stderrBytes: 16 * 1024 };
const ownershipLabel = "dev.dim.review-tracing.owner";
type Evaluation = Parameters<ReviewTraceRuntime["evaluate"]>[0];
type Tracker = ReturnType<typeof createReadTracker>;

function dockerEnvironment(config: string): NodeJS.ProcessEnv {
  // Explicit connection selectors are operator input. All CLI credentials/proxies
  // come from this empty private configuration, never the operator's config.json.
  return { ...process.env, DOCKER_CONFIG: config };
}

async function docker(config: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], { env: dockerEnvironment(config), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", finished = false;
    const fail = (error: Error) => { if (!finished) { finished = true; child.kill("SIGKILL"); reject(error); } };
    const timeout = setTimeout(() => fail(new Error("review tracing Docker command timed out")), 10_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (Buffer.byteLength(stdout) > 8192) fail(new Error("review tracing Docker output limit")); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (Buffer.byteLength(stderr) > 8192) fail(new Error("review tracing Docker error limit")); });
    child.on("error", fail);
    child.on("close", (code) => { clearTimeout(timeout); if (finished) return; finished = true; code === 0 ? resolve(stdout) : reject(new Error(`review tracing Docker command failed (${code}): ${stderr}`)); });
  });
}

async function removeOwnedContainer(config: string, name: string, owner: string, knownId?: string): Promise<void> {
  let id = knownId;
  if (id === undefined) {
    // A failed CLI may have submitted create successfully without returning its
    // identity. Find only this invocation's exact name AND unpredictable label.
    const found = (await docker(config, ["container", "ls", "--all", "--no-trunc", "--filter", `name=^/${name}$`, "--filter", `label=${ownershipLabel}=${owner}`, "--format", "{{.ID}}"])).trim();
    if (found === "") return;
    if (!/^[0-9a-f]{64}$/.test(found)) throw new Error("review tracing cleanup lookup returned an invalid container identity");
    id = found;
  }
  const inspected: unknown = JSON.parse(await docker(config, ["container", "inspect", "--format", '{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "dev.dim.review-tracing.owner")}}}', id]));
  if (inspected === null || typeof inspected !== "object" || Array.isArray(inspected)) throw new Error("review tracing cleanup cannot verify ownership");
  const identity = inspected as Record<string, unknown>;
  if (identity.id !== id || identity.name !== `/${name}` || identity.owner !== owner || !/^[0-9a-f]{64}$/.test(id)) throw new Error("review tracing cleanup ownership mismatch");
  await docker(config, ["rm", "--force", id]);
}

function execute(config: string, id: string, input: Evaluation, tracker: Tracker): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["start", "--attach", "--interactive", id], { env: dockerEnvironment(config), stdio: ["pipe", "pipe", "pipe"] });
    let output = "", stderr = "", stdoutBytes = 0, bytes = 0, lastId = 0, inflight = 0, matched: boolean | undefined, finished = false;
    let pending = Promise.resolve();
    const fail = (error: Error) => { if (finished) return; finished = true; cleanup(); child.kill("SIGKILL"); reject(error); };
    const abort = () => fail(new Error("review tracing was aborted"));
    const timeout = setTimeout(() => fail(new Error("review tracing execution timed out")), limits.executionMs);
    const cleanup = () => { clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted === true) abort();
    child.stdin.on("error", (error) => { if (matched === undefined) fail(error); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; if (Buffer.byteLength(stderr) > limits.stderrBytes) fail(new Error("review tracing stderr limit")); });
    const receive = (line: string) => {
      const raw: unknown = JSON.parse(line);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid review tracing protocol message");
      const message = raw as Record<string, unknown>;
      if (matched !== undefined) throw new Error("review detector emitted output after its result");
      if (message.type === "result") {
        if (Object.keys(message).sort().join(",") !== "matches,type" || typeof message.matches !== "boolean" || inflight !== 0) throw new Error("invalid review tracing result");
        matched = message.matches;
        child.stdin.end();
        return;
      }
      if (message.type !== "read" || Object.keys(message).sort().join(",") !== "id,path,role,type,view" || !Number.isSafeInteger(message.id) || message.id !== lastId + 1 || typeof message.path !== "string" || message.path.length > 1024 || (message.role !== "dependency" && message.role !== "target") || (message.view !== "before" && message.view !== "after") || (message.role === "dependency" && message.view !== "after")) throw new Error("invalid review tracing read request");
      const request = { id: message.id as number, path: message.path, role: message.role, view: message.view };
      if (++lastId > limits.requests) throw new Error("review tracing request limit");
      inflight++;
      pending = pending.then(async () => {
        if (finished) return;
        const content = await tracker.read(request.path, request.role as "dependency" | "target", request.view as "before" | "after");
        if (content !== undefined) {
          bytes += content.length;
          if (content.length > limits.fileBytes || bytes > limits.totalBytes) throw new Error("review tracing file content limit");
        }
        inflight--;
        if (!finished) child.stdin.write(JSON.stringify({ type: "read-result", id: request.id, content: content === undefined ? null : content.toString("utf8") }) + "\n");
      }).catch((error: unknown) => { fail(error instanceof Error ? error : new Error(String(error))); });
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      try {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > limits.stdoutBytes) throw new Error("review tracing stdout limit");
        output += chunk;
        let end: number;
        while ((end = output.indexOf("\n")) !== -1) { const line = output.slice(0, end); output = output.slice(end + 1); receive(line); }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    child.on("error", (error) => { cleanup(); fail(error); });
    child.on("close", (code) => {
      cleanup();
      if (finished) return;
      if (code !== 0 || matched === undefined || inflight !== 0 || output !== "") { fail(new Error(`review tracing execution failed (${code}): ${stderr}`)); return; }
      finished = true;
      resolve(matched);
    });
    const init = JSON.stringify({ type: "init", entrypoint: input.entrypoint, changes: input.changes });
    if (Buffer.byteLength(init) > limits.fileBytes) { cleanup(); fail(new Error("review tracing input limit")); return; }
    child.stdin.write(init + "\n");
  });
}

/** Run candidate code only in an unprivileged, networkless, read-only container. */
export async function createNodeReviewTraceRuntime(): Promise<ReviewTraceRuntime> {
  const runner = await readFile(new URL("./assets/runner.mjs", import.meta.url), "utf8");
  const revision = createHash("sha256").update(await readFile(new URL(import.meta.url))).update("\0").update(runner).update("\0").update(image).digest("hex");
  return {
    name: "node", revision,
    async evaluate(input) {
      input.signal?.throwIfAborted();
      const tracker = createReadTracker(input);
      // This read cannot be reclassified by candidate code or omitted by an
      // alternate guest protocol. The tracker also makes dependency win over target.
      await tracker.read(input.entrypoint, "dependency", "after");
      const config = await mkdtemp(join(tmpdir(), "dim-review-trace-docker-"));
      const owner = randomUUID();
      const name = `dim-review-trace-${owner}`;
      let id: string | undefined;
      try {
        id = (await docker(config, ["create", "--name", name, "--label", `${ownershipLabel}=${owner}`, "--pull=never", "--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=128m", "--cpus=1", "--interactive", "--log-driver=none", image, "node", "--no-warnings", "--experimental-vm-modules", "--input-type=module", "-e", runner])).trim();
        if (!/^[0-9a-f]{64}$/.test(id)) { id = undefined; throw new Error("Docker returned an invalid review tracing container identity"); }
        input.signal?.throwIfAborted();
        const matches = await execute(config, id, input, tracker);
        return { matches, manifest: tracker.manifest() };
      } finally {
        try { await removeOwnedContainer(config, name, owner, id); }
        finally { await rm(config, { recursive: true, force: true }); }
      }
    }
  };
}
