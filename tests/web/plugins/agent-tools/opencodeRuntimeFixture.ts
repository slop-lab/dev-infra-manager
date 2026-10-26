import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Route } from "playwright-core";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const STAGED_SITE = process.env.DIM_OPENCODE_PAGES_SITE ?? join(REPOSITORY_ROOT, ".local/opencode-link/site");
const OPENCODE = process.env.DIM_OPENCODE_BINARY ?? "opencode";
const PIN = "1.18.31";

type Backend = {
  readonly endpoint: string;
  readonly password: string;
  readonly username: string;
  createSession(directory: string): Promise<string>;
  sessionPreserved(directory: string, id: string): Promise<boolean>;
  stop(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
};

export type OpenCodeRuntimeFixture = {
  readonly first: Backend;
  readonly second: Backend;
  readonly unicodeDirectory: string;
  routePages(context: BrowserContext): Promise<void>;
  close(): Promise<void>;
};

async function availablePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listener missing");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForHealth(port: number, username: string, password: string): Promise<void> {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/global/health`, { headers: { authorization }, signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "TimeoutError")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OpenCode fixture did not become healthy");
}

async function createBackend(root: string, name: string, certificate: { readonly key: Buffer; readonly cert: Buffer }): Promise<Backend> {
  const home = join(root, name);
  const directories = ["config", "data", "state", "cache", "tmp"] as const;
  await Promise.all(directories.map((directory) => mkdir(join(home, directory), { recursive: true, mode: 0o700 })));
  const username = `fixture-${randomBytes(12).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  const backendPort = await availablePort();
  let child: ChildProcess | undefined;
  let startupBytes = 0;
  const gateway = createHttpsServer(certificate, (request, response) => {
    const upstream = httpRequest({ hostname: "127.0.0.1", port: backendPort, method: request.method, path: request.url, headers: request.headers }, (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    upstream.on("error", () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  gateway.on("upgrade", (request, socket, head) => {
    const upstream = connect(backendPort, "127.0.0.1", () => {
      const headers = Object.entries(request.headers).flatMap(([key, value]) => value === undefined ? [] : [`${key}: ${Array.isArray(value) ? value.join(", ") : value}`]);
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address();
  if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("TLS gateway missing");
  const environment = {
    HOME: home,
    PATH: process.env.PATH ?? "",
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    TMPDIR: join(home, "tmp"),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  };
  const version = spawnSync(OPENCODE, ["--version"], { env: environment, cwd: home, encoding: "utf8", timeout: 5000 });
  if (version.status !== 0 || version.stdout.trim() !== PIN) {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    throw new Error("Isolated OpenCode version does not match the reviewed pin");
  }
  async function start(): Promise<void> {
    if (child) return;
    child = spawn(OPENCODE, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(backendPort), "--cors", "https://slop-lab.github.io"], {
      cwd: REPOSITORY_ROOT,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (bytes: Buffer) => { startupBytes += bytes.length; };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    try {
      await waitForHealth(backendPort, username, password);
    } catch (error) {
      process.stderr.write(`Isolated OpenCode startup failed: exit=${child.exitCode}; outputBytes=${startupBytes}\n`);
      await stop();
      throw error;
    }
  }
  async function stop(): Promise<void> {
    const running = child;
    child = undefined;
    if (!running?.pid) return;
    const group = running.pid;
    const signal = (value: NodeJS.Signals) => {
      try { process.kill(-group, value); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    };
    if (running.exitCode === null) await new Promise<void>((resolve) => {
      const force = setTimeout(() => signal("SIGKILL"), 2000);
      running.once("exit", () => { clearTimeout(force); resolve(); });
      signal("SIGTERM");
    });
    signal("SIGKILL");
  }
  try { await start(); }
  catch (error) { await new Promise<void>((resolve) => gateway.close(() => resolve())); throw error; }
  async function sessions(directory: string, method = "GET"): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${backendPort}/session?${new URLSearchParams({ directory })}`, {
      method, headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Fixture session API failed: status=${response.status}`);
    return response.json();
  }
  return {
    endpoint: `https://127.0.0.1:${gatewayAddress.port}`,
    password,
    username,
    async createSession(directory) {
      const value = await sessions(directory, "POST");
      if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") throw new Error("Invalid fixture session response");
      return value.id;
    },
    async sessionPreserved(directory, id) {
      const value = await sessions(directory);
      if (!Array.isArray(value)) throw new Error("Invalid fixture session list");
      return value.some((session: unknown) => !!session && typeof session === "object" && "id" in session && session.id === id);
    },
    start,
    stop,
    async close() {
      await stop();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    },
  };
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".js")) return "text/javascript";
  if (pathname.endsWith(".css")) return "text/css";
  if (pathname.endsWith(".html")) return "text/html";
  if (pathname.endsWith(".json")) return "application/json";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  if (pathname.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

export async function createOpenCodeRuntimeFixture(): Promise<OpenCodeRuntimeFixture> {
  await mkdir(join(REPOSITORY_ROOT, ".local"), { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(REPOSITORY_ROOT, ".local/opencode-workspace-open-"));
  const unicodeDirectory = join(root, "space and 日本語");
  await mkdir(unicodeDirectory, { recursive: true });
  const keyPath = join(root, "gateway.key");
  const certPath = join(root, "gateway.crt");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath, "-days", "1"], { stdio: "ignore", timeout: 10_000 });
  if (generated.status !== 0) throw new Error("fixture certificate generation failed");
  const certificate = { key: await readFile(keyPath), cert: await readFile(certPath) };
  let first: Backend | undefined;
  let second: Backend | undefined;
  try {
    first = await createBackend(root, "first", certificate);
    second = await createBackend(root, "second", certificate);
  } catch (error) {
    await Promise.all([first?.close(), second?.close()]);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  if (!first || !second) throw new Error("OpenCode fixture initialization failed");
  const firstBackend = first;
  const secondBackend = second;
  return {
    first: firstBackend,
    second: secondBackend,
    unicodeDirectory,
    async routePages(context) {
      await context.route("https://slop-lab.github.io/dev-infra-manager/opencode-web/**", async (route: Route) => {
        const url = new URL(route.request().url());
        const suffix = decodeURIComponent(url.pathname.slice("/dev-infra-manager/opencode-web/".length));
        const file = join(STAGED_SITE, "opencode-web", !suffix || suffix.endsWith("/") ? `${suffix}index.html` : suffix);
        if (!file.startsWith(join(STAGED_SITE, "opencode-web") + "/")) { await route.fulfill({ status: 404 }); return; }
        try { await route.fulfill({ body: await readFile(file), contentType: contentType(file) }); }
        catch (error) { if (error instanceof Error) await route.fulfill({ status: 404 }); else throw error; }
      });
    },
    async close() {
      await Promise.all([firstBackend.close(), secondBackend.close()]);
      await rm(root, { recursive: true, force: true });
    },
  };
}
