import { execFile, spawn } from "node:child_process";
import { createServer, request, type RequestOptions } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { PublicGitDependencies } from "../../../../packages/host/plugins/native-git/src/public-git-network.js";
const execute = promisify(execFile);
export async function publicGitFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-public-git-")), source = join(root, "source"), scratch = join(root, "scratch");
  await mkdir(scratch, { mode: 0o700 }); await mkdir(source);
  const git = (args: readonly string[]) => execute("/usr/bin/git", [...args], { env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  await git(["init", "-b", "main", source]);
  await git(["-C", source, "config", "user.name", "Fixture"]); await git(["-C", source, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(source, "README.md"), "public Git fixture\n");
  await writeFile(join(source, ".gitmodules"), '[submodule "trap"]\npath=trap\nurl=file:///private/never-read\n');
  await writeFile(join(source, ".gitattributes"), "README.md filter=trap\n");
  await git(["-C", source, "add", "."]); await git(["-C", source, "commit", "-m", "fixture"]);
  await git(["clone", "--bare", source, join(root, "upstream.git")]);
  const commit = (await git(["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  let mode: "smart" | "redirect" | "dumb" | "slow" = "smart";
  const paths: string[] = [], network: import("node:https").RequestOptions[] = [];
  const server = createServer((incoming, response) => {
    paths.push(incoming.url ?? "");
    if (mode === "redirect") { response.writeHead(302, { location: "https://127.0.0.1/private" }).end(); return; }
    if (mode === "dumb") { response.writeHead(200, { "content-type": "text/plain" }).end("https://127.0.0.1/private\n"); return; }
    if (mode === "slow") return;
    const url = new URL(incoming.url!, "http://fixture");
    const child = spawn("/usr/bin/git", ["http-backend"], { env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: incoming.method!, CONTENT_TYPE: incoming.headers["content-type"] ?? "", CONTENT_LENGTH: incoming.headers["content-length"] ?? "0", SERVER_PROTOCOL: "HTTP/1.1", REMOTE_ADDR: "127.0.0.1" }, stdio: ["pipe", "pipe", "pipe"] });
    incoming.pipe(child.stdin); const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.resume(); child.on("error", () => response.writeHead(500).end());
    child.on("close", () => {
      const bytes = Buffer.concat(output), separator = bytes.indexOf("\r\n\r\n");
      if (separator < 0) { response.writeHead(500).end(); return; }
      const headers: Record<string, string> = {}; let status = 200;
      for (const row of bytes.subarray(0, separator).toString().split("\r\n")) {
        const colon = row.indexOf(":"), key = row.slice(0, colon).toLowerCase(), value = row.slice(colon + 1).trim();
        if (key === "status") status = Number(value.split(" ")[0]); else headers[key] = value;
      }
      response.writeHead(status, headers).end(bytes.subarray(separator + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture listener");
  const dependencies: PublicGitDependencies = { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request(options, callback) {
    network.push(options);
    const local: RequestOptions = { hostname: "127.0.0.1", port: address.port, path: options.path!, method: options.method!, headers: options.headers!, signal: options.signal!, agent: false };
    return request(local, callback);
  } };
  return { root, source, scratch, commit, paths, network, git, dependencies, mode: (next: typeof mode) => { mode = next; },
    input: { url: "https://public.example.org/upstream.git", scratchRoot: scratch, gitExecutable: "/usr/bin/git" },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  };
}
