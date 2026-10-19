import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importReviewedImage } from "../../../../packages/host/plugins/vm/src/images.js";
import { config } from "./fixture.js";

const helper = path.resolve(import.meta.dirname, "../../../../packages/host/plugins/vm/scripts/artifact-cache.bash");
const bytes = Buffer.from("reviewed image bytes for resumable host cache");
const digest = createHash("sha256").update(bytes).digest("hex");
function download(url: string, cache: string, checksum = digest) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", [helper, url, checksum], { env: { ...process.env, DIM_ARTIFACT_CACHE: cache } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject); child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("host VM artifact cache", () => {
  it("deduplicates concurrent cold downloads, verifies hits and resumes partial bytes", async () => {
    const cache = await mkdtemp(path.join(tmpdir(), "dim-artifacts-"));
    let requests = 0; const ranges: string[] = [];
    const server = createServer((request, response) => {
      requests++; const range = request.headers.range; if (range) ranges.push(range);
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1]) : 0;
      if (request.url?.endsWith("/interrupted") && !range) {
        response.writeHead(200, { "Content-Length": bytes.length, Connection: "close" });
        response.end(bytes.subarray(0, 8)); return;
      }
      response.writeHead(start ? 206 : 200, { "Content-Length": bytes.length - start, ...(start ? { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) });
      response.end(bytes.subarray(start));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing HTTP listener");
    const url = `http://127.0.0.1:${address.port}/image`;
    try {
      const results = await Promise.all([download(url, cache), download(url, cache)]);
      expect(results.map((result) => result.status), JSON.stringify(results)).toEqual([0, 0]);
      expect(requests).toBe(1);
      expect(results[0]?.stdout.trim()).toBe(path.join(cache, digest));
      await writeFile(path.join(cache, digest), "corrupt");
      expect((await download(url, cache)).status).toBe(0); expect(requests).toBe(2);
      await rm(path.join(cache, digest));
      expect((await download(`${url}/interrupted`, cache)).status).not.toBe(0);
      expect(await readFile(path.join(cache, `${digest}.partial`))).toEqual(bytes.subarray(0, 8));
      expect((await download(`${url}/interrupted`, cache)).status).toBe(0);
      expect(ranges).toEqual(["bytes=8-"]);
      expect(await readFile(path.join(cache, digest))).toEqual(bytes);
      expect((await download(url, cache, "0".repeat(64))).status).not.toBe(0);
      await expect(readFile(path.join(cache, "0".repeat(64)))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { server.close(); await once(server, "close"); await rm(cache, { recursive: true, force: true }); }
  });

  it("imports verified files in the configured local Incus project and verifies the VM fingerprint", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const result = await importReviewedImage(config, { url: "https://images.test/metadata", sha256: digest, rootfs: { url: "https://images.test/rootfs", sha256: "b".repeat(64) } }, {
      async run(command, args) {
        calls.push({ command, args });
        const stdout = command === "bash" ? `/cache/${args[2]}\n` : args.includes("import") ? `Image imported with fingerprint: ${"c".repeat(64)}\n` : JSON.stringify({ fingerprint: "c".repeat(64), type: "virtual-machine" });
        return { command, args, stdout, stderr: "", exitCode: 0 };
      }
    }, new AbortController().signal);
    expect(result).toBe("c".repeat(64));
    expect(calls[2]?.args).toEqual(["--force-local", "--project", "dim", "image", "import", `/cache/${digest}`, `/cache/${"b".repeat(64)}`]);
    expect(calls[3]?.args).toContain(`/1.0/images/${result}?project=dim`);
  });
});
