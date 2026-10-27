import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const [modulePath, root] = process.argv.slice(2);
if (!modulePath || !root) throw new Error("provide an isolated GS artifact and fixture root");
const api: typeof import("../../../packages/gs/repository/src/index.js") = await import(pathToFileURL(modulePath).href);
const execute = promisify(execFile), git = join(root, "git"), storageRoot = join(root, "storage");
await mkdir(root, { recursive: true, mode: 0o700 }); await copyFile("/usr/bin/git", git); await chmod(git, 0o755);
const environment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HOME: "/dev/null", LC_ALL: "C" };
const runGit = (args: readonly string[]) => execute(git, [...args], { env: environment, timeout: 20_000 });
const version = (await runGit(["--version"])).stdout.trim().replace(/^git version /, "");
const runtime = { gitExecutable: git, gitVersion: version, storageRoot };
const first = { namespaceId: "first", repositoryId: "main" }, second = { namespaceId: "second", repositoryId: "main" };
const firstPath = await api.initializeRepository(runtime, first), secondPath = await api.initializeRepository(runtime, second);
const source = join(root, "source"); await runGit(["init", "--initial-branch=main", source]);
await writeFile(join(source, "README.md"), "seed\n");
await runGit(["-C", source, "add", "."]);
await runGit(["-C", source, "-c", "user.name=GS fixture", "-c", "user.email=gs@example.invalid", "commit", "-m", "seed"]);
for (const destination of [firstPath, secondPath]) await runGit(["--git-dir", destination, "fetch", source, "refs/heads/main:refs/heads/main"]);
const initial = (await runGit(["--git-dir", firstPath, "rev-parse", "refs/heads/main"])).stdout.trim();
const grants = new Map([
  ["Basic " + Buffer.from("writer:fixture-password").toString("base64"), { selector: first, principalId: "writer-first", role: "writer" as const }],
  ["Basic " + Buffer.from("reader:fixture-password").toString("base64"), { selector: first, principalId: "reader-first", role: "reader" as const }]
]);
const server = await api.createRepositoryService({ runtime,
  repositories: [first, second].map((selector) => ({ selector, protectedRefs: ["refs/heads/main", "refs/heads/development"] })),
  authorize: async ({ request }) => grants.get(request.headers.authorization ?? "") });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); if (!address || typeof address === "string") throw new Error("standalone GS listener missing");
const origin = `http://127.0.0.1:${address.port}`;
try {
  const clone = join(root, "clone");
  await runGit(["clone", `${origin.replace("http://", "http://writer:fixture-password@")}\/v1/namespaces/first/repositories/main.git`, clone]);
  await writeFile(join(clone, "README.md"), "ordinary write\n"); await runGit(["-C", clone, "add", "."]);
  await runGit(["-C", clone, "-c", "user.name=GS fixture", "-c", "user.email=gs@example.invalid", "commit", "-m", "ordinary write"]);
  await runGit(["-C", clone, "push", "origin", "HEAD:refs/heads/feature"]);
  const candidate = (await runGit(["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
  assert.equal((await runGit(["--git-dir", firstPath, "rev-parse", "refs/heads/feature"])).stdout.trim(), candidate);
  let denied = false;
  try { await runGit(["-C", clone, "push", "origin", "HEAD:refs/heads/main"]); }
  catch (error) {
    if (!(error instanceof Error) || !("stderr" in error) || typeof error.stderr !== "string" || !error.stderr.includes("pre-receive hook declined")) throw error;
    denied = true;
  }
  assert.equal(denied, true); assert.equal((await runGit(["--git-dir", firstPath, "rev-parse", "refs/heads/main"])).stdout.trim(), initial);
  const reader = "Basic " + Buffer.from("reader:fixture-password").toString("base64");
  const foreign = await fetch(`${origin}/v1/namespaces/second/repositories/main.git/info/refs?service=git-upload-pack`, { headers: { authorization: reader } });
  assert.equal(foreign.status, 404); await foreign.body?.cancel();
  const hook = join(firstPath, "hooks/pre-receive"), previous = await readFile(hook);
  await writeFile(hook, "tampered\n");
  const tampered = await fetch(`${origin}/v1/namespaces/first/repositories/main.git/info/refs?service=git-upload-pack`, { headers: { authorization: reader } });
  assert.equal(tampered.status, 503); await tampered.body?.cancel(); await writeFile(hook, previous); await chmod(hook, 0o700);
  const replacement = join(root, "replacement-git"); await copyFile("/usr/bin/git", replacement); await chmod(replacement, 0o755); await rename(replacement, git);
  const replaced = await fetch(`${origin}/v1/namespaces/first/repositories/main.git/info/refs?service=git-upload-pack`, { headers: { authorization: reader } });
  assert.equal(replaced.status, 503); await replaced.body?.cancel();
  process.stdout.write(`${JSON.stringify({ initial, candidate, protectedHead: initial, foreignStatus: foreign.status,
    tamperedHookStatus: tampered.status, replacedExecutableStatus: replaced.status })}\n`);
} finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
