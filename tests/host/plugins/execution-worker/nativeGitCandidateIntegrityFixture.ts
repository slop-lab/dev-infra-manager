import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  openNativeGitCandidateReadAuthority,
  type NativeGitCandidateReadSession
} from "../../../../packages/host/plugins/execution-worker/src/nativeGitCandidateReadAuthority.js";
import { gitHttpFixture } from "../../../support/gitHttpFixture.js";

type Candidate = { readonly commit: string; readonly tree: string };
type InstrumentedGitMode = "reject-fsck" | "corrupt-commit" | "corrupt-tree" | "corrupt-blob";

export type NativeGitCandidateIntegrityFixture = {
  readonly destinationParent: string;
  commitCandidate(path: string, bytes: string, name: string): Promise<Candidate>;
  instrumentedGit(mode: InstrumentedGitMode): Promise<{ readonly executable: string; readonly calls: string }>;
  corruptingEndpoint(): Promise<{ readonly origin: string; corrupted(): boolean }>;
  openReader(candidate: Candidate, options?: {
    readonly gitExecutable?: string;
    readonly serviceEndpoint?: string;
  }): NativeGitCandidateReadSession;
  close(): Promise<void>;
};

export async function nativeGitCandidateIntegrityFixture(): Promise<NativeGitCandidateIntegrityFixture> {
  const native = await gitHttpFixture();
  const clone = join(native.root, "candidate-writer");
  const temporaryRoot = join(native.root, "candidate-reader-temp");
  const destinationParent = join(native.root, "candidate-destinations");
  const repository = native.repositoryPath("project-a", "source");
  await native.git(native.root, ["clone", repository, clone]);
  await native.git(clone, ["config", "user.name", "DIM writer"]);
  await native.git(clone, ["config", "user.email", "writer@example.invalid"]);
  await mkdir(temporaryRoot, { mode: 0o700 });
  await mkdir(destinationParent, { mode: 0o700 });
  const initialHead = (await native.git(clone, ["rev-parse", "HEAD"])).stdout.trim();
  const servers: Server[] = [];
  const readers: NativeGitCandidateReadSession[] = [];
  const service = await uploadPackServer(repository, false, servers);

  return {
    destinationParent,
    async commitCandidate(path, bytes, name) {
      await writeFile(join(clone, path), bytes);
      await native.git(clone, ["add", "--", path]);
      await native.git(clone, ["commit", "-m", path]);
      const commit = (await native.git(clone, ["rev-parse", "HEAD"])).stdout.trim();
      const tree = (await native.git(clone, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
      await native.git(clone, ["push", repository, `${commit}:refs/heads/proposals/workspace-a/${name}`]);
      return { commit, tree };
    },
    async instrumentedGit(mode) {
      const directory = join(native.root, `instrumented-${mode}`);
      const executable = join(directory, "git");
      const calls = join(directory, "calls.jsonl");
      await mkdir(directory, { mode: 0o700 });
      await writeFile(executable, instrumentedGitScript(mode, calls), { mode: 0o700 });
      return { executable, calls };
    },
    corruptingEndpoint: () => uploadPackServer(repository, true, servers),
    openReader(candidate, options = {}) {
      const reader = openNativeGitCandidateReadAuthority({
        gitExecutable: options.gitExecutable ?? "/usr/bin/git",
        serviceEndpoint: options.serviceEndpoint ?? service.origin,
        credential: { username: "reader-a", password: "reader-a-secret-1" },
        temporaryRoot,
        claim: {
          projectId: "project-a",
          repositoryId: "source",
          protectedRef: "refs/heads/main",
          expectedProtectedHead: initialHead,
          candidateCommit: candidate.commit,
          candidateTree: candidate.tree
        }
      });
      readers.push(reader);
      return reader;
    },
    async close() {
      await Promise.all(readers.map((reader) => reader.close()));
      await Promise.all(servers.map((server) => closeServer(server)));
      await native.close();
    }
  };
}

function instrumentedGitScript(mode: InstrumentedGitMode, calls: string): string {
  return `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (${JSON.stringify(mode)} === "reject-fsck" && (args.some((argument) => ["fsck", "verify-pack", "--batch-all-objects"].includes(argument))
  || args.includes("rev-list") && (args.includes("--all") || args.includes("--objects")))) process.exit(91);
const result = spawnSync("/usr/bin/git", args, { env: process.env });
if (result.error) throw result.error;
let output = result.stdout;
const catFile = args.indexOf("cat-file");
const selectedType = catFile < 0 ? undefined : args[catFile + 1];
if (result.status === 0 && output.length > 0 && ${JSON.stringify(mode)} === "corrupt-" + selectedType) {
  output = Buffer.from(output);
  output[output.length - 1] ^= 1;
}
process.stdout.write(output);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`;
}

async function uploadPackServer(
  repository: string,
  corruptPack: boolean,
  servers: Server[]
): Promise<{ readonly origin: string; corrupted(): boolean }> {
  let corrupted = false;
  const server = createServer((request, response) => {
    const options = { repository, corruptPack, markCorrupted: () => { corrupted = true; } };
    void serveUploadPack(request, response, options);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected pack proxy listener");
  return { origin: `http://127.0.0.1:${address.port}`, corrupted: () => corrupted };
}

async function serveUploadPack(
  request: IncomingMessage,
  response: ServerResponse,
  options: { readonly repository: string; readonly corruptPack: boolean; readonly markCorrupted: () => void }
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname.endsWith("/info/refs")
    && url.searchParams.get("service") === "git-upload-pack") {
    const advertisement = runUploadPack(["--stateless-rpc", "--advertise-refs", options.repository]);
    const body = Buffer.concat([Buffer.from("001e# service=git-upload-pack\n0000"), advertisement]);
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "application/x-git-upload-pack-advertisement",
      "content-length": body.length
    }).end(body);
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = runUploadPack(["--stateless-rpc", options.repository], Buffer.concat(chunks));
    const pack = options.corruptPack ? body.indexOf("PACK") : -1;
    if (pack >= 0 && pack + 20 < body.length) {
      body.writeUInt8(body.readUInt8(pack + 20) ^ 1, pack + 20);
      options.markCorrupted();
    }
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "application/x-git-upload-pack-result",
      "content-length": body.length
    }).end(body);
    return;
  }
  response.writeHead(404).end();
}

function runUploadPack(args: readonly string[], input?: Buffer): Buffer {
  const result = spawnSync("/usr/bin/git", ["upload-pack", ...args], {
    env: { ...process.env, GIT_PROTOCOL: "version=0" },
    input,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error("upload-pack fixture failed");
  return result.stdout;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
