import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ReviewChangeMatcher } from "../../../packages/control-plane/plugins/git-review/src/change-matchers.ts";
import { reviewChangeMatcherExtension } from "../../../packages/control-plane/plugins/git-review/src/change-matchers.ts";

const image = "docker.io/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df";
const maxBytes = 256 * 1024;
export interface ProjectMatcherInput {
  readonly source: string;
  readonly changes: readonly { readonly oldPath?: string; readonly newPath?: string; readonly before?: string; readonly after?: string }[];
}
export type ProjectMatcherExecutor = (input: ProjectMatcherInput) => Promise<boolean>;
// No candidate import reaches this process. Both code and data cross stdin only.
const wrapper = `let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>262144)throw Error('input limit');}const input=JSON.parse(raw);const mod=await import('data:text/javascript;base64,'+Buffer.from(input.source).toString('base64'));const result=await mod.matches(input.changes);if(typeof result!=='boolean')throw Error('matcher must return boolean');process.stdout.write(JSON.stringify(result));`;
function docker(config: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], { env: { ...process.env, DOCKER_CONFIG: config }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", stopped = false;
    const fail = (error: Error) => { if (stopped) return; stopped = true; child.kill("SIGKILL"); reject(error); };
    const timeout = setTimeout(() => fail(new Error("project matcher Docker command timed out")), 10_000);
    const collect = (chunk: Buffer, error: boolean) => {
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 4096) fail(new Error("project matcher output limit"));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stdin.on("error", () => {});
    child.on("error", fail);
    child.on("close", (code) => { clearTimeout(timeout); if (stopped) return; stopped = true; code === 0 ? resolve(stdout) : reject(new Error(`project matcher Docker command failed (${code}): ${stderr}`)); });
    child.stdin.end(input);
  });
}
export async function runDockerProjectMatcher(input: ProjectMatcherInput): Promise<boolean> {
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error("project matcher input limit");
  // A private empty CLI config also prevents automatic proxy credential injection.
  const config = await mkdtemp(join(tmpdir(), "dim-project-review-docker-"));
  let id: string | undefined;
  try {
    id = (await docker(config, ["create", "--pull=never", "--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=128m", "--cpus=1", "--interactive", image, "node", "--input-type=module", "-e", wrapper])).trim();
    if (!/^[0-9a-f]{64}$/.test(id)) { id = undefined; throw new Error("Docker returned an invalid container identity"); }
    const result: unknown = JSON.parse(await docker(config, ["start", "--attach", "--interactive", id], encoded));
    if (typeof result !== "boolean") throw new Error("project matcher must return one JSON boolean");
    return result;
  } finally {
    try { if (id !== undefined) await docker(config, ["rm", "--force", id]); }
    finally { await rm(config, { recursive: true, force: true }); }
  }
}
/** Install this reviewed adapter as a control-plane extension; matcher code stays in the project. */
export async function createProjectReviewMatcher(custom?: { readonly execute: ProjectMatcherExecutor; readonly revision: string }): Promise<ReviewChangeMatcher> {
  if (custom !== undefined && !/^[0-9a-f]{64}$/.test(custom.revision)) throw new Error("custom project matcher executor requires an explicit SHA256 revision");
  const execute = custom?.execute ?? runDockerProjectMatcher;
  const revision = createHash("sha256").update(await readFile(new URL(import.meta.url))).update("\0").update(custom?.revision ?? "default-docker-executor").digest("hex");
  return {
    name: "project-guard",
    revision,
    validate(options) { if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).length !== 0) throw new Error("project-guard options must be an empty object"); },
    async matches(input) {
      // Evaluator code, its dependencies and configuration are unconditionally guarded.
      // Do not run a candidate evaluator when it changes its own guard.
      if (input.changes.some(({ oldPath, newPath }) => [oldPath, newPath].some((path) => path === ".dim" || path?.startsWith(".dim/") === true))) return true;
      const source = await input.readCandidateFile(".dim/review/matcher.mjs");
      if (source === undefined || source.length > 64 * 1024) throw new Error("candidate project matcher is missing or exceeds 64 KiB");
      const changes: ProjectMatcherInput["changes"][number][] = [];
      let bytes = source.length;
      for (const change of input.changes) {
        const read = async (objectId: string): Promise<string | undefined> => {
          if (objectId === "0") return undefined;
          const blob = await input.readBlob(objectId); bytes += blob.length;
          if (bytes > 128 * 1024) throw new Error("project matcher changed-content limit");
          return blob.toString("utf8");
        };
        const before = await read(change.oldObjectId), after = await read(change.newObjectId);
        changes.push({ ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }), ...(change.newPath === undefined ? {} : { newPath: change.newPath }), ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
      }
      return execute({ source: source.toString("utf8"), changes });
    }
  };
}
export async function projectReviewMatcherExtension() { return reviewChangeMatcherExtension(await createProjectReviewMatcher()); }
