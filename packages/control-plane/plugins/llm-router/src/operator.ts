import { backup } from "node:sqlite";
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tryAcquireKernelGuard } from "@slop-lab/dim-control-plane-core/lock";
import { object, parseConfig, privateFile, text, type RouterConfig } from "./config.js";
import { effectiveRouterConfig } from "./account-catalog.js";
import { RouterLedger, hash } from "./ledger.js";

export function effectivePolicy(config: RouterConfig, ledger: RouterLedger, projectId: string) {
  const project = ledger.project(projectId);
  return { ...project, serviceLimits: config.limits, period: { kind: "UTC calendar day", timeZone: "UTC", booking: "admission" },
    strict: ["authenticated project/route/model", "project and service request/concurrency", "request/response bytes", "required capture capacity"],
    tokenEnforcement: project.policy.tokenMode === "estimate" ? "estimate admission; unknown usage reservation retained; overage possible" : "observe only; missing usage unknown",
    unavailable: ["strict token/currency ceilings", "provider subscription remaining allowance", "hidden attempt accounting", "backend-confirmed cancellation", "project-scoped provider continuation"],
    accountBindings: project.policy.allowedRoutes.map((id) => { const route = config.routes.find((route) => route.id === id); return { routeId: id, accountId: route?.accountId ?? null, binding: "exclusive-worker declared by operator" }; }),
    revision: hash(JSON.stringify({ project: project.revision, backend: config.backend, serviceLimits: config.limits, routes: config.routes })) };
}
export async function accountHealth(config: RouterConfig) {
  return Promise.all(config.accounts.map(async (account) => {
    const observedAt = new Date().toISOString();
    try {
      const key = (await privateFile(account.keyFile, 16 * 1024)).trim();
      const response = await fetch(`${account.endpoint}/v1/models`, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${key}` } });
      await response.body?.cancel();
      return { accountId: account.id, reference: account.reference, observedAt, localCredentialReadable: true, backendAuthentication: response.status === 401 || response.status === 403 ? "reauthorization_or_access_key_required" : response.ok ? "accepted" : "unavailable", status: response.status,
        providerReachability: "not probed", providerQuota: "unknown", billableInferencePerformed: false, credentialLifecycleOwner: "CLIProxyAPI", exclusiveBinding: "operator assertion; no backend account identity observation" };
    } catch { return { accountId: account.id, reference: account.reference, observedAt, backendAuthentication: "unknown", providerReachability: "not probed", providerQuota: "unknown", billableInferencePerformed: false }; }
  }));
}
interface BackupManifest { schemaVersion: 1; config: RouterConfig; files: Record<string, string>; createdAt: string; backendCredentials: Record<string, "included" | "external-not-included"> }
async function safeBytes(file: string, maximum = 256 * 1024 * 1024): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0 || info.size > maximum) throw new Error(`unsafe private backup input: ${file}`); return await handle.readFile(); }
  finally { await handle.close(); }
}
async function privateTree(source: string, destination: string, files: Record<string, string>, prefix: string): Promise<void> {
  const directory = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { const info = await directory.stat(); if (info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0) throw new Error("credential/archive directory must be private and owned"); }
  finally { await directory.close(); }
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("backup rejects symbolic links");
    if (entry.isDirectory()) await privateTree(join(source, entry.name), join(destination, entry.name), files, `${prefix}/${entry.name}`);
    else if (entry.isFile()) { const bytes = await safeBytes(join(source, entry.name)); await writeFile(join(destination, entry.name), bytes, { mode: 0o600, flag: "wx" }); files[`${prefix}/${entry.name}`] = hash(bytes); }
    else throw new Error("backup rejects special files");
  }
}
export async function backupRouter(baseConfig: RouterConfig, destination: string, options: { backendStateQuiesced?: boolean } = {}): Promise<void> {
  const config = await effectiveRouterConfig(baseConfig);
  if (config.accounts.some((account) => account.credentialDirectory) && options.backendStateQuiesced !== true) throw new Error("stop configured backend credential writers and explicitly confirm backendStateQuiesced before backup");
  const guard = await tryAcquireKernelGuard(join(config.stateDirectory, "service.guard"));
  if (!guard) throw new Error("stop the LLM router before taking a consistent backup");
  const operatorGuard = await tryAcquireKernelGuard(join(config.stateDirectory, "operator-service.guard"));
  if (!operatorGuard) { await guard.release(); throw new Error("stop the router operator service before taking a consistent backup"); }
  const ledger = new RouterLedger(config.stateDirectory);
  try {
    await mkdir(destination, { mode: 0o700 }); await mkdir(join(destination, "state"), { mode: 0o700 });
    ledger.audit("operator", "backup.create", "router", { inferenceReplay: false });
    const database = join(destination, "state/router.sqlite3"); await backup(ledger.database, database); await chmod(database, 0o600);
    const files: Record<string, string> = { "state/router.sqlite3": hash(await safeBytes(database)) };
    try { await privateTree(join(config.stateDirectory, "captures"), join(destination, "state/captures"), files, "state/captures"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (config.accounts.some((account) => account.provider)) await privateTree(join(config.stateDirectory, "managed-accounts"), join(destination, "state/managed-accounts"), files, "state/managed-accounts");
    await mkdir(join(destination, "accounts"), { mode: 0o700 });
    const backendCredentials: BackupManifest["backendCredentials"] = {};
    for (const account of config.accounts) {
      const directory = join(destination, "accounts", account.id); await mkdir(directory, { mode: 0o700 });
      const key = await safeBytes(account.keyFile, 16 * 1024); await writeFile(join(directory, "access.key"), key, { mode: 0o600, flag: "wx" }); files[`accounts/${account.id}/access.key`] = hash(key);
      if (account.credentialDirectory) { await privateTree(account.credentialDirectory, join(directory, "backend-auth"), files, `accounts/${account.id}/backend-auth`); backendCredentials[account.id] = "included"; }
      else backendCredentials[account.id] = "external-not-included";
    }
    await mkdir(join(destination, "operators"), { mode: 0o700 });
    for (const actor of config.operators ?? []) {
      const path = `operators/${actor.id}.key`, bytes = await safeBytes(actor.keyFile, 16 * 1024);
      await writeFile(join(destination, path), bytes, { mode: 0o600, flag: "wx" }); files[path] = hash(bytes);
    }
    await mkdir(join(destination, "host-issuers"), { mode: 0o700 });
    for (const issuer of config.hostIssuers) {
      const path = `host-issuers/${issuer.id}.key`, bytes = await safeBytes(issuer.keyFile, 16 * 1024);
      await writeFile(join(destination, path), bytes, { mode: 0o600, flag: "wx" }); files[path] = hash(bytes);
    }
    const manifest: BackupManifest = { schemaVersion: 1, config, files, createdAt: new Date().toISOString(), backendCredentials };
    await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
  } finally { ledger.close(); await operatorGuard.release(); await guard.release(); }
}
export async function restoreRouter(source: string, destination: string): Promise<string> {
  const raw = object(JSON.parse(await privateFile(join(source, "manifest.json"), 4 * 1024 * 1024)));
  if (raw.schemaVersion !== 1) throw new Error("unsupported backup manifest");
  const config = parseConfig(raw.config), inventory = object(raw.files);
  if (!inventory["state/router.sqlite3"]) throw new Error("backup contains no ledger");
  await mkdir(destination, { mode: 0o700 });
  for (const [file, digest] of Object.entries(inventory)) {
    const inside = relative(source, resolve(source, file));
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || inside !== file || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid backup file inventory");
    const bytes = await safeBytes(join(source, file)); if (hash(bytes) !== digest) throw new Error(`backup integrity check failed: ${file}`);
    await mkdir(join(destination, file, ".."), { recursive: true, mode: 0o700 }); await writeFile(join(destination, file), bytes, { mode: 0o600, flag: "wx" });
  }
  const restored = parseConfig({ ...config, stateDirectory: join(destination, "state"),
    ...(config.operators === undefined ? {} : { operators: config.operators.map((actor) => ({ ...actor, keyFile: join(destination, "operators", `${actor.id}.key`) })) }),
    hostIssuers: config.hostIssuers.map((issuer) => ({ ...issuer, keyFile: join(destination, "host-issuers", `${issuer.id}.key`) })),
    accounts: config.accounts.map((account) => ({ ...account, keyFile: account.provider ? join(destination, "state/managed-accounts", account.id, "access.key") : join(destination, "accounts", account.id, "access.key"),
      ...(account.credentialDirectory === undefined ? {} : { credentialDirectory: account.provider ? join(destination, "state/managed-accounts", account.id, "auth") : join(destination, "accounts", account.id, "backend-auth") }) })) });
  for (const actor of restored.operators ?? []) await safeBytes(actor.keyFile, 16 * 1024);
  for (const issuer of restored.hostIssuers) await safeBytes(issuer.keyFile, 16 * 1024);
  for (const account of restored.accounts) {
    await safeBytes(account.keyFile, 16 * 1024);
    if (account.provider) {
      const file = join(destination, "state/managed-accounts", account.id, "config.yaml");
      const worker = object(JSON.parse(await privateFile(file)));
      worker.oauth = { ...object(worker.oauth), "auth-dir": account.credentialDirectory };
      await writeFile(file, JSON.stringify(worker, null, 2) + "\n", { mode: 0o600 });
    }
    if (account.credentialDirectory) { await mkdir(account.credentialDirectory, { recursive: true, mode: 0o700 }); const directory = await open(account.credentialDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await directory.close(); }
  }
  const ledger = new RouterLedger(restored.stateDirectory);
  try { ledger.recoverInterrupted(); ledger.audit("operator", "backup.restore", "router", { replayed: false }); } finally { ledger.close(); }
  const file = join(destination, "router.json"); await writeFile(file, JSON.stringify(restored, null, 2), { mode: 0o600, flag: "wx" }); return file;
}
