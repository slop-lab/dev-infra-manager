import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile, readFile, stat, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { sysboxAcquisitionFailure } from "../execution-worker/sysboxAcquisitionFixture.js";

const helper = new URL("../../../../packages/host/plugins/native-git/src/guest/dim-ci.mjs", import.meta.url).pathname;
const fetchFixture = new URL("./ciFetchFixture.ts", import.meta.url).href;
it("offers offline help and rejects unknown request flags before Git or credential lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-ci-cli-"));
  const environment = { HOME: root, PATH: "" };
  try {
    const help = await promisify(execFile)(process.execPath, [helper, "--help"], { cwd: root, env: environment, timeout: 2000 });
    expect(help.stdout).toContain("--request-id"); expect(help.stderr).toBe("");
    try {
      await promisify(execFile)(process.execPath, [helper, "request", "--request-id", "c946b18f-08bb-4f33-a06d-ea2d4de18d74", "--job-schema", "PRIVATE_INPUT"], { cwd: root, env: environment, timeout: 2000 });
      throw new Error("unsupported request flag was accepted");
    } catch (error) {
      if (!(error instanceof Error) || !("stderr" in error) || typeof error.stderr !== "string" || !("code" in error)) throw error;
      expect(error.code).toBe(2); expect(error.stderr).toContain("--request-id"); expect(error.stderr).not.toContain("PRIVATE_INPUT");
    }
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("downloads only explicitly selected, digest-verified request evidence to a new destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-ci-evidence-cli-"));
  const credential = "x".repeat(43), requestId = randomUUID(), job = randomUUID(), artifactId = "a".repeat(64);
  const bytes = Buffer.alloc(1024 * 1024 + 37, 37);
  let invalidDigest = false, redirect = false, declaredBytes = bytes.length, logMode = false, retention = true, missingLog = false;
  const seen: string[] = [];
  const prefix = `/services/native-git/v1/projects/project-a/repositories/root/workspace-ci/requests/${requestId}`;
  const server = createServer((request, response) => {
    seen.push(request.url ?? "");
    if (request.headers.authorization !== `Basic ${Buffer.from(`dim:${credential}`).toString("base64")}`) { response.writeHead(401).end(); return; }
    if (request.url === `${prefix}/jobs/${job}/artifacts`) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ executionId: job, availability: retention ? "complete" : "unavailable",
        artifacts: missingLog ? [] : [{ id: artifactId, name: logMode ? "logs/stdout.log" : "../../never-use-metadata-as-output", bytes: declaredBytes,
          sha256: `sha256:${invalidDigest ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex")}` }] })); return;
    }
    if (request.url === `${prefix}/jobs/${job}/logs`) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: { completion: { kind: "executor-failure", code: "artifact-upload-timeout" }, logs: {
        stdout: { base64: Buffer.from("bounded old prefix").toString("base64"), truncated: true },
        stderr: { base64: "", truncated: false },
      } } })); return;
    }
    if (request.url === `${prefix}/jobs/${job}/artifacts/${artifactId}`) {
      if (redirect) { response.writeHead(302, { location: "/operator-secret" }).end(); return; }
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes); return;
    }
    response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture listener");
  const environment = { HOME: root, PATH: root, DIM_TEST_CI_ENDPOINT: `http://127.0.0.1:${address.port}` };
  const git = join(root, "git");
  await writeFile(git, `#!${process.execPath}\nif(process.argv[2]==='remote') console.log('http://127.0.0.1:19420/services/native-git/v1/projects/project-a/repositories/root.git'); else if(process.argv[2]==='credential') {process.stdin.resume();process.stdin.on('end',()=>console.log('username=dim\\npassword=${credential}'));} else process.exit(2);\n`, { mode: 0o700 });
  const invoke = (output: string) => promisify(execFile)(process.execPath, ["--import", fetchFixture, helper, "download", "--request-id", requestId, "--job", job,
    "--artifact", artifactId, "--output", output], { cwd: root, env: environment, timeout: 10_000 });
  const rejected = async (output: string) => {
    try { await invoke(output); throw new Error("unsafe download succeeded"); }
    catch (error) {
      if (!(error instanceof Error) || !("stderr" in error)) throw error;
      expect(String(error.stderr)).not.toContain(credential);
    }
  };
  try {
    const destination = join(root, "selected-proof.bin");
    const success = await invoke(destination);
    expect(success.stdout).not.toContain(credential); expect(success.stderr).toBe("");
    expect(await readFile(destination)).toEqual(bytes); expect((await stat(destination)).mode & 0o777).toBe(0o600);
    await rejected(destination); expect(await readFile(destination)).toEqual(bytes);
    const link = join(root, "link.bin"); await symlink(destination, link); await rejected(link);
    invalidDigest = true;
    const corrupt = join(root, "corrupt.bin"); await rejected(corrupt); await expect(stat(corrupt)).rejects.toMatchObject({ code: "ENOENT" });
    invalidDigest = false; redirect = true;
    const moved = join(root, "redirect.bin"); await rejected(moved); await expect(stat(moved)).rejects.toMatchObject({ code: "ENOENT" });
    expect(seen).not.toContain("/operator-secret");
    redirect = false; declaredBytes = 128 * 1024 * 1024 + 1;
    await rejected(join(root, "too-large.bin"));
    declaredBytes = bytes.length - 1; await rejected(join(root, "wrong-size.bin"));
    declaredBytes = bytes.length; logMode = true;
    const logs = (extra: string[] = []) => promisify(execFile)(process.execPath, ["--import", fetchFixture, helper, "logs", "--request-id", requestId, "--job", job,
      "--stream", "stdout", ...extra], { cwd: root, env: environment, timeout: 10_000 });
    const tail = await logs(["--tail-bytes", "32"]);
    expect(tail.stdout).toContain("retained-log tail"); expect(tail.stdout).toContain("truncated=true");
    expect(tail.stdout.length).toBeLessThan(1024); expect(tail.stdout).toMatch(/%{32}\n$/);
    const full = join(root, "full-log.bin"); await logs(["--output", full]); expect(await readFile(full)).toEqual(bytes);
    retention = false;
    expect((await logs(["--tail-bytes", "32"])).stdout).toContain("collection=unavailable");
    missingLog = true;
    expect((await logs()).stdout).toContain("diagnostic-prefix; retained log unavailable; truncated=true");
    expect((await logs()).stdout).toContain("reason=artifact-upload-timeout");
    expect((await readdir(root)).sort()).toEqual(["git", "selected-proof.bin", "link.bin", "full-log.bin"].sort());
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  }
});

it("exposes a real pre-runtime acquisition failure when a verified empty retained log contradicts its diagnostic", async () => {
  // Given a backend result from a real timed-out Git request, with no candidate runtime created.
  const { result, stderr } = await sysboxAcquisitionFailure("timeout");
  expect(result.completion).toEqual({ kind: "executor-failure", code: "candidate-read-timeout" });
  const root = await mkdtemp(join(tmpdir(), "dim-ci-acquisition-cli-"));
  const requestId = randomUUID(), job = result.executionId, artifact = "b".repeat(64), credential = "z".repeat(43);
  const base = `/services/native-git/v1/projects/project-a/repositories/root/workspace-ci/requests/${requestId}/jobs/${job}`;
  let retained = Buffer.alloc(0), diagnostic = stderr, badDigest = false, logReads = 0;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from(`dim:${credential}`).toString("base64")}`) { response.writeHead(401).end(); return; }
    if (request.url === `${base}/artifacts`) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ executionId: job, availability: "complete", artifacts: [{
        id: artifact, name: "logs/stderr.log", bytes: retained.length,
        sha256: `sha256:${badDigest ? "0".repeat(64) : createHash("sha256").update(retained).digest("hex")}`,
      }] })); return;
    }
    if (request.url === `${base}/artifacts/${artifact}`) { response.writeHead(200, { "content-type": "application/octet-stream" }).end(retained); return; }
    if (request.url === `${base}/logs`) {
      logReads++;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: { ...result,
        logs: { ...result.logs, stderr: { base64: diagnostic.toString("base64"), truncated: false } } } })); return;
    }
    response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture listener");
    await writeFile(join(root, "git"), `#!${process.execPath}\nif(process.argv[2]==='remote') console.log('http://127.0.0.1:19420/services/native-git/v1/projects/project-a/repositories/root.git'); else if(process.argv[2]==='credential') {process.stdin.resume();process.stdin.on('end',()=>console.log('username=dim\\npassword=${credential}'));} else process.exit(2);\n`, { mode: 0o700 });
    const logs = (extra: string[] = []) => promisify(execFile)(process.execPath, ["--import", fetchFixture, helper, "logs", "--request-id", requestId, "--job", job,
      "--stream", "stderr", ...extra], { cwd: root, env: { HOME: root, PATH: root, DIM_TEST_CI_ENDPOINT: `http://127.0.0.1:${address.port}` }, timeout: 10_000 });
    // When the normal scoped CLI sees conflicting empty retained evidence.
    const displayed = await logs();
    // Then it exposes the actual bounded diagnostic with honest provenance, never empty success.
    expect(displayed.stdout).toBe("");
    expect(displayed.stderr).toContain("diagnostic-prefix; retained log empty");
    expect(displayed.stderr).toContain(stderr.toString());
    expect(displayed.stderr).toContain("reason=candidate-read-timeout");
    expect(displayed.stderr).not.toContain(credential);
    const destination = join(root, "must-not-be-a-complete-log.txt");
    await expect(logs(["--output", destination])).rejects.toMatchObject({ code: 2 });
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    badDigest = true;
    await expect(logs()).rejects.toMatchObject({ code: 2 });
    badDigest = false; retained = stderr;
    const before = logReads;
    const complete = await logs();
    expect(complete.stderr).toContain("retained-log tail");
    expect(complete.stderr).toContain(stderr.toString());
    expect(logReads).toBe(before);
    retained = Buffer.alloc(0); diagnostic = Buffer.alloc(0);
    expect((await logs()).stderr).toContain("retained-log tail; collection=complete; 0/0 bytes");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
