import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { tryAcquireKernelGuard } from "@slop-lab/dim-control-plane-core/lock";
import { identifier, privateFile, type RouterAccount, type RouterConfig, type RouterModel } from "./config.js";

const execute = promisify(execFile);
const workers = new Map<string, { child: ChildProcess; close(): Promise<void> }>();
const loginChildren = new Map<string, { child: ChildProcess; done: Promise<void> }>();
const starting = new Map<string, Promise<void>>();
export interface ManagedAccountInput { accountId: string; reference: string; provider: "codex" | "openai" | "anthropic"; endpoint?: string; apiKey?: string; models?: RouterModel[] }
export interface AccountLogin { accountId: string; sessionId: string; status: "pending" | "connected" | "failed"; verificationUrl?: string; userCode?: string; expiresAt: number; message?: string }
const directory = (config: RouterConfig, id: string) => join(config.stateDirectory, "managed-accounts", identifier(id));
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077)) throw new Error("managed backend directories must be owned and private");
}
async function executable(config: RouterConfig): Promise<string> {
  const binary = config.accountManagement?.backendExecutable;
  if (!binary) throw new Error("managed account enrollment requires a configured CLIProxyAPI executable");
  const stat = await lstat(binary);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.geteuid?.()) || (stat.mode & 0o022) || !(stat.mode & 0o111)) throw new Error("unsafe managed CLIProxyAPI executable");
  const { stdout, stderr } = await execute(binary, ["-h"], { timeout: 5000, maxBuffer: 65536, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  if (!/CLIProxyAPI Version:\s*8\.0\.33(?:\s|,)/.test(stdout + stderr)) throw new Error("managed backend requires CLIProxyAPI 8.0.33");
  return binary;
}
async function unusedPort(config: RouterConfig): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("unable to reserve managed backend port");
  if (config.accounts.some(({ endpoint }) => new URL(endpoint).port === String(address.port))) return unusedPort(config);
  return address.port;
}
/** Each worker contains exactly one upstream credential and no ambient provider configuration. */
export async function createManagedAccount(config: RouterConfig, input: ManagedAccountInput): Promise<RouterAccount> {
  if (input.provider !== "codex") {
    if (!input.endpoint || !input.apiKey || /[\r\n]/.test(input.apiKey)) throw new Error("API accounts require endpoint and key");
    const endpoint = new URL(input.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw new Error("API endpoint requires HTTPS or loopback HTTP without credentials, query or fragment");
  }
  await executable(config);
  const root = join(config.stateDirectory, "managed-accounts"); await privateDirectory(root);
  const path = directory(config, input.accountId);
  await mkdir(path, { mode: 0o700 }); // Existing partitions are never adopted or overwritten.
  try {
  await privateDirectory(join(path, "auth"));
  const keyFile = join(path, "access.key"), key = randomBytes(32).toString("base64url"), port = await unusedPort(config);
  const provider = input.provider;
  if (provider !== "codex" && (!input.apiKey || !input.endpoint)) throw new Error("API accounts require endpoint and key");
  const yaml: Record<string, unknown> = {
    "config-version": 8, server: { host: "127.0.0.1", port, discovery: { enabled: false } },
    management: { "secret-key": "", "disable-control-panel": true }, access: { "api-keys": [key] },
    oauth: { "auth-dir": join(path, "auth") },
    routing: { strategy: "fill-first", retry: { "request-retry": 0, "max-retry-credentials": 1, "max-retry-interval": 0 } },
    requests: { streaming: { "bootstrap-retries": 0 } },
    observability: { logs: { debug: false, "logging-to-file": false, "request-log": false, "error-logs-max-files": 0 } },
    "quota-exceeded": { "switch-project": false, "switch-preview-model": false }
  };
  if (provider !== "codex") {
    const entry = { name: input.accountId, "base-url": input.endpoint, "request-retry": 0,
      keys: [{ "api-key": input.apiKey }], models: (input.models ?? []).map(({ id }) => ({ name: id, alias: id })) };
    yaml["api-keys"] = { [provider === "anthropic" ? "claude" : "openai-compatibility"]: [entry] };
  }
  // JSON is a YAML subset; strings remain quoted regardless of operator input.
  await writeFile(join(path, "config.yaml"), JSON.stringify(yaml, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(keyFile, key + "\n", { mode: 0o600, flag: "wx" });
  return { id: identifier(input.accountId), reference: input.reference, provider, endpoint: `http://127.0.0.1:${port}`, keyFile, credentialDirectory: join(path, "auth") };
  } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
}
function start(binary: string, path: string, flags: string[]): ChildProcess {
  return spawn(binary, ["-config", join(path, "config.yaml"), "-local-model", ...flags], {
    cwd: path, env: { HOME: path, PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"]
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000); timer.unref();
    child.once("close", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
  });
}
/** Only the inference owner calls this; operator listeners never start worker daemons. */
export async function ensureManagedBackend(config: RouterConfig, account: RouterAccount): Promise<void> {
  if (!account.provider) return;
  const path = directory(config, account.id), pending = starting.get(path);
  if (pending) return pending;
  const ready = startManagedBackend(config, account); starting.set(path, ready);
  try { await ready; } finally { if (starting.get(path) === ready) starting.delete(path); }
}
async function startManagedBackend(config: RouterConfig, account: RouterAccount): Promise<void> {
  const path = directory(config, account.id);
  if (workers.has(path)) return;
  await privateDirectory(path);
  const guard = await tryAcquireKernelGuard(join(path, "worker.guard"), { timeoutMilliseconds: 100 });
  if (!guard) throw new Error("managed account backend already belongs to another inference process");
  let owner: { child: ChildProcess; close(): Promise<void> } | undefined;
  try {
    const binary = await executable(config), child = start(binary, path, []);
    owner = { child, close: async () => { await stop(child); await guard.release(); workers.delete(path); } };
    workers.set(path, owner); child.stdout?.resume(); child.stderr?.resume();
    let failed = false; child.once("error", () => { failed = true; }); child.once("close", () => { void guard.release(); workers.delete(path); });
    const key = (await privateFile(account.keyFile)).trim();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failed || child.exitCode !== null || child.signalCode !== null) throw new Error("managed account backend failed to start");
      try { const response = await fetch(account.endpoint + "/v1/models", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(300) }); if (response.ok) return; } catch { /* Wait for listener startup, never perform inference. */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    await owner.close(); throw new Error("managed account backend did not become ready");
  } catch (error) { if (owner) await owner.close(); else await guard.release(); throw error; }
}
export async function closeManagedBackends(config: RouterConfig): Promise<void> {
  const prefix = join(config.stateDirectory, "managed-accounts") + "/";
  await Promise.allSettled([...starting].filter(([path]) => path.startsWith(prefix)).map(([, ready]) => ready));
  await Promise.all([...workers].filter(([path]) => path.startsWith(prefix)).map(([, owner]) => owner.close()));
  await closeManagedLogins(config);
}
export async function closeManagedLogins(config: RouterConfig): Promise<void> {
  const prefix = join(config.stateDirectory, "managed-accounts") + "/";
  await Promise.all([...loginChildren].filter(([path]) => path.startsWith(prefix)).map(async ([, login]) => { await stop(login.child); await login.done; }));
}
async function saveLogin(path: string, value: AccountLogin): Promise<void> {
  const stage = join(path, `login-${value.sessionId}.tmp-${randomUUID()}`), target = join(path, `login-${value.sessionId}.json`);
  await writeFile(stage, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await rename(stage, target);
}
async function hasCredential(path: string): Promise<boolean> {
  for (const name of await readdir(join(path, "auth"))) {
    if (!name.endsWith(".json")) continue;
    const file = join(path, "auth", name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || stat.size > 1024 * 1024) throw new Error("unsafe managed OAuth credential");
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof value === "object" && value !== null && "type" in value && value.type === "codex" && "refresh_token" in value && typeof value.refresh_token === "string" && value.refresh_token.length) return true;
  }
  return false;
}
export async function startAccountLogin(config: RouterConfig, account: RouterAccount): Promise<AccountLogin> {
  if (account.provider !== "codex") throw new Error("device login is available only for managed Codex accounts");
  const path = directory(config, account.id);
  if (await hasCredential(path)) throw new Error("this Codex account is already connected; add a separate account to connect another identity");
  const guard = await tryAcquireKernelGuard(join(path, "login.guard"), { timeoutMilliseconds: 100 });
  if (!guard) throw new Error("this account already has a login in progress");
  let child: ChildProcess;
  try { child = start(await executable(config), path, ["-codex-device-login", "-no-browser"]); }
  catch (error) { await guard.release(); throw error; }
  const session: AccountLogin = { accountId: account.id, sessionId: randomUUID(), status: "pending", expiresAt: Date.now() + 15 * 60_000 };
  let completed!: () => void;
  const done = new Promise<void>((resolve) => { completed = resolve; });
  loginChildren.set(path, { child, done });
  let output = "", published = false, finished = false;
  try { await saveLogin(path, session); } catch (error) { await stop(child); await guard.release(); loginChildren.delete(path); completed(); throw error; }
  const finish = async (success: boolean) => {
    if (finished) return; finished = true;
    clearTimeout(timeout);
    session.status = success && await hasCredential(path).catch(() => false) ? "connected" : "failed";
    if (session.status === "failed") session.message = "Codex login did not complete; start a new device login.";
    try { await saveLogin(path, session); } finally { await guard.release(); loginChildren.delete(path); completed(); }
  };
  const timeout = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000); timeout.unref();
  child.once("error", () => { void finish(false).catch(() => {}); }); child.once("close", (code) => { void finish(code === 0).catch(() => {}); });
  return new Promise<AccountLogin>((resolve, reject) => {
    const readyTimeout = setTimeout(() => { void stop(child); reject(new Error("Codex device login did not provide a code")); }, 20_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 65536) { clearTimeout(readyTimeout); void stop(child); reject(new Error("Codex login output exceeded its bound")); return; }
      const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/);
      if (!published && output.includes("https://auth.openai.com/codex/device") && code) {
        published = true; clearTimeout(readyTimeout); session.verificationUrl = "https://auth.openai.com/codex/device"; session.userCode = code[0];
        void saveLogin(path, session).then(() => resolve({ ...session }), reject);
      }
    };
    child.stdout?.on("data", receive); child.stderr?.on("data", receive);
    child.once("close", () => { if (!published) { clearTimeout(readyTimeout); reject(new Error("Codex device login exited before providing a code")); } });
    child.once("error", () => { clearTimeout(readyTimeout); reject(new Error("unable to start Codex device login")); });
  });
}
export async function accountLoginStatus(config: RouterConfig, account: RouterAccount, sessionId: string): Promise<AccountLogin> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId)) throw new Error("invalid account login session");
  const value = JSON.parse(await privateFile(join(directory(config, account.id), `login-${sessionId}.json`))) as AccountLogin;
  if (value.accountId !== account.id || value.sessionId !== sessionId) throw new Error("account login session mismatch");
  if (value.status === "pending" && Date.now() > value.expiresAt) return { ...value, status: "failed", message: "Device login expired; start a new device login." };
  return value;
}

/** Publish model aliases before a route becomes eligible; CLIProxyAPI watches its config. */
export async function configureManagedAccountModels(config: RouterConfig, account: RouterAccount, models: RouterModel[]): Promise<void> {
  if (!account.provider || account.provider === "codex") return;
  const path = directory(config, account.id), file = join(path, "config.yaml");
  const value = JSON.parse(await privateFile(file)) as Record<string, unknown>;
  const providers = value["api-keys"] as Record<string, { models: { name: string; alias: string }[] }[]>;
  const rows = providers[account.provider === "anthropic" ? "claude" : "openai-compatibility"];
  if (!rows || rows.length !== 1) throw new Error("managed account provider partition is invalid");
  rows[0]!.models = models.map(({ id }) => ({ name: id, alias: id }));
  const stage = join(path, `config.tmp-${randomUUID()}`);
  await writeFile(stage, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await rename(stage, file);
}

/** This checks a dedicated partition's saved credential, never a host Codex auth store. */
export async function managedAccountConnected(config: RouterConfig, account: RouterAccount): Promise<boolean> {
  return account.provider === "codex" ? hasCredential(directory(config, account.id)) : !!account.provider;
}
