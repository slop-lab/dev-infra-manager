import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { abortable, publicGitAddress, publicGitBranch, publicGitLookup, publicGitRequest, publicGitUrl, type PublicGitDependencies } from "./public-git-network.js";
export { publicGitUrl, publicGitBranch } from "./public-git-network.js";
const execute = promisify(execFile);
export interface PublicGitSourceInput { readonly url: string; readonly branch?: string; readonly scratchRoot: string; readonly gitExecutable: string; readonly signal?: AbortSignal }
/** Fetch objects through a pinned smart-HTTP relay; never check out or run repository code. */
export async function preparePublicGitSource(input: PublicGitSourceInput, dependencies: PublicGitDependencies = {}): Promise<{ directory: string; selectedRef: string; cleanup(): Promise<void> }> {
  const source = publicGitUrl(input.url), branch = input.branch === undefined ? undefined : publicGitBranch(input.branch);
  if (!isAbsolute(input.scratchRoot) || !isAbsolute(input.gitExecutable)) throw new Error("public Git source requires absolute trusted paths");
  const parent = await lstat(input.scratchRoot);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.geteuid?.() || (parent.mode & 0o777) !== 0o700) throw new Error("public Git scratch root must be an owned private directory");
  const maximum = dependencies.maximumBytes ?? 256 * 1024 * 1024, deadline = dependencies.deadlineMilliseconds ?? 170_000;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 256 * 1024 * 1024 || !Number.isSafeInteger(deadline) || deadline <= 0 || deadline > 170_000) throw new Error("invalid trusted public Git transfer bounds");
  const lifecycle = new AbortController();
  const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(deadline), ...(input.signal ? [input.signal] : [])]);
  signal.throwIfAborted();
  const host = source.hostname.replace(/^\[|\]$/g, "");
  const addresses = await abortable((dependencies.lookup ?? publicGitLookup)(host), signal);
  if (!addresses.length || addresses.some(({ address }) => !publicGitAddress(address))) throw new Error("public Git DNS must resolve exclusively to public addresses");
  const pinned = addresses[0]!;
  const root = await mkdtemp(join(input.scratchRoot, "public-git-")), directory = join(root, "repository.git"), home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const token = `/${randomBytes(24).toString("hex")}`, requestUpstream = dependencies.request ?? publicGitRequest;
  let bytes = 0, requests = 0;
  function count(chunk: Buffer) { bytes += chunk.length; if (bytes > maximum) throw new Error("public Git transfer exceeds its byte limit"); }
  async function relay(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const advertisement = incoming.method === "GET" && incoming.url === `${token}/info/refs?service=git-upload-pack`;
    const pack = incoming.method === "POST" && incoming.url === `${token}/git-upload-pack`;
    if ((!advertisement && !pack) || ++requests > 32) { response.writeHead(404).end(); return; }
    if (pack && incoming.headers["content-type"] !== "application/x-git-upload-pack-request") { response.writeHead(400).end(); return; }
    const body: Buffer[] = []; let requestBytes = 0;
    for await (const value of incoming) { const chunk = Buffer.from(value); count(chunk); requestBytes += chunk.length; if (requestBytes > 4 * 1024 * 1024) throw new Error("public Git negotiation is too large"); body.push(chunk); }
    const suffix = advertisement ? "/info/refs?service=git-upload-pack" : "/git-upload-pack";
    const upstream = await abortable(new Promise<IncomingMessage>((resolve, reject) => {
      const request = requestUpstream({ protocol: "https:", hostname: host, port: 443, servername: host, method: advertisement ? "GET" : "POST",
        path: `${source.pathname.replace(/\/$/, "")}${suffix}`, agent: false, rejectUnauthorized: true, signal,
        lookup(_hostname, options, callback) { callback(null, options.all ? [{ address: pinned.address, family: pinned.family }] : pinned.address, pinned.family); },
        headers: { host: source.host, accept: advertisement ? "application/x-git-upload-pack-advertisement" : "application/x-git-upload-pack-result",
          "accept-encoding": "identity", "user-agent": "DIM-public-git", ...(pack ? { "content-type": "application/x-git-upload-pack-request", "content-length": String(requestBytes), ...(incoming.headers["content-encoding"] === "gzip" ? { "content-encoding": "gzip" } : {}) } : {}) }
      }, resolve);
      request.once("error", reject); request.end(Buffer.concat(body));
    }), signal);
    const expectedType = advertisement ? "application/x-git-upload-pack-advertisement" : "application/x-git-upload-pack-result";
    if (upstream.statusCode !== 200 || upstream.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== expectedType
      || upstream.headers["content-encoding"] && upstream.headers["content-encoding"] !== "identity") {
      upstream.destroy(); throw new Error("public Git requires a successful smart-HTTP response without redirects");
    }
    response.writeHead(200, { "content-type": expectedType, "cache-control": "no-store" });
    try { for await (const value of upstream) { const chunk = Buffer.from(value); count(chunk); if (!response.write(chunk)) await abortable(once(response, "drain"), signal); } response.end(); }
    finally { upstream.destroy(); }
  }
  const server = createServer((incoming, response) => { void relay(incoming, response).catch(() => { if (response.headersSent) response.destroy(); else response.writeHead(502).end(); }); });
  server.requestTimeout = 15_000; server.headersTimeout = 5_000;
  const stop = () => { server.closeAllConnections(); server.close(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    server.listen(0, "127.0.0.1"); await abortable(once(server, "listening"), signal);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing public Git relay listener");
    // A minimal environment excludes ambient credentials, helpers, config, proxies and injected Git settings.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", GIT_ALLOW_PROTOCOL: "http", GIT_PROTOCOL_FROM_USER: "0", GIT_NO_REPLACE_OBJECTS: "1" };
    const safe = ["-c", "protocol.version=0", "-c", "http.proxy=", "-c", "http.followRedirects=false", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "-c", "gc.auto=0"];
    await execute(input.gitExecutable, [...safe, "clone", "--bare", "--single-branch", "--no-tags", "--no-recurse-submodules", ...(branch ? ["--branch", branch] : []), "--", `http://127.0.0.1:${address.port}${token}`, directory], { env, signal, timeout: deadline, maxBuffer: 256 * 1024 });
    const result = await execute(input.gitExecutable, [...safe, "--git-dir", directory, "symbolic-ref", "HEAD"], { env, signal, timeout: 5_000, maxBuffer: 4096 });
    const selectedRef = result.stdout.trim();
    if (!selectedRef.startsWith("refs/heads/")) throw new Error("public Git source has no concrete default branch");
    publicGitBranch(selectedRef.slice("refs/heads/".length));
    await execute(input.gitExecutable, [...safe, "--git-dir", directory, "rev-parse", "--verify", `${selectedRef}^{commit}`], { env, signal, timeout: 5_000, maxBuffer: 4096 });
    return { directory, selectedRef, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch { await rm(root, { recursive: true, force: true }); throw new Error("Public Git acquisition failed. Use an accessible public HTTPS smart-HTTP repository and branch within the transfer limits"); }
  finally { signal.removeEventListener("abort", stop); lifecycle.abort(); stop(); }
}
