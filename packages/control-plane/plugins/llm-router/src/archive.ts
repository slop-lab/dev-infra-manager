import { createHash } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { RouterLedger, hash } from "./ledger.js";
import { text, type ProjectPolicy } from "./config.js";

export class ArchiveError extends Error {}

/** Client application bodies only. No auth headers, hidden attempts or remote referenced bytes are claimed. */
export class ExchangeArchive {
  private output: Awaited<ReturnType<typeof open>> | undefined;
  private enabled: boolean;
  private failed = false;
  private stored = 0;
  private finalResponseHash: string | undefined;
  private responseDigest = createHash("sha256");
  private readonly directory: string;
  constructor(private readonly ledger: RouterLedger, readonly id: string, private readonly projectId: string, private readonly policy: ProjectPolicy) {
    this.enabled = policy.captureMode !== "metadata"; this.directory = join(ledger.directory, "captures", id);
  }
  async begin(bytes: Buffer): Promise<void> {
    if (!this.enabled) return;
    await this.record(async () => {
      if (this.policy.limits.captureBytesPerProject !== null && this.ledger.captureUsage(this.projectId) > this.policy.limits.captureBytesPerProject) throw new ArchiveError("capture capacity exhausted");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const input = await open(join(this.directory, "request.json"), "wx", 0o600);
      try { await input.writeFile(bytes); await input.sync(); this.stored += bytes.length; this.ledger.captureInput(this.id, hash(bytes)); } finally { await input.close(); }
      this.output = await open(join(this.directory, "response.body"), "wx", 0o600); await this.output.sync();
      for (const directory of [this.directory, join(this.ledger.directory, "captures"), this.ledger.directory]) {
        const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
        try { await handle.sync(); } finally { await handle.close(); }
      }
    });
  }
  async append(bytes: Uint8Array): Promise<void> {
    if (!this.enabled) return;
    await this.record(async () => {
      if (!this.output) throw new Error("capture output is unavailable");
      this.ledger.append(this.id, this.projectId, bytes.length, this.policy.limits.captureBytesPerProject);
      await this.output.writeFile(bytes); await this.output.sync(); this.responseDigest.update(bytes); this.stored += bytes.length;
    });
  }
  private async record(operation: () => Promise<void>): Promise<void> {
    try { await operation(); }
    catch (error) {
      this.failed = true; this.enabled = false; this.ledger.captureFailure(this.id, this.stored);
      if (this.policy.captureMode === "required") throw new ArchiveError("required archive failed", { cause: error });
    }
  }
  result() { return { complete: this.policy.captureMode !== "metadata" && !this.failed, ...(this.output ? { responseHash: this.finalResponseHash ??= this.responseDigest.digest("hex") } : {}) }; }
  async close(): Promise<void> { await this.output?.close(); }
}
export function captureManifest(ledger: RouterLedger, id: string, projectId?: string) {
  const row = ledger.request(id, projectId);
  return { requestId: row.id, projectId: row.project_id, principalId: row.principal_id, attemptId: row.attempt_id,
    routeId: row.route_id, upstreamAccountId: row.account_id, accountAttribution: "configured exclusive backend binding; not a backend identity observation",
    requestedModel: row.requested_model, observedModel: row.observed_model, policyRevision: row.policy_revision,
    execution: row.execution, delivery: row.delivery, accounting: row.accounting,
    capture: { state: row.capture_state, complete: row.capture_complete === 1, boundary: "client application protocol bodies",
      authenticationHeaders: "excluded", upstreamTranslatedPayloads: "not observed", remoteReferences: "referenced bytes not fetched",
      responseStatus: row.response_status, responseContentType: row.response_content_type,
      requestSha256: row.request_sha256, responseSha256: row.response_sha256, accountedStorageBytes: row.capture_bytes, storageAccounting: "includes conservative unfinished write reservations until retention/reconciliation",
      requestPath: `/v1/requests/${id}/request`, responsePath: `/v1/requests/${id}/response` } };
}
export async function captureBody(ledger: RouterLedger, id: string, kind: "request" | "response", projectId?: string): Promise<Buffer> {
  const row = ledger.request(id, projectId);
  if (["disabled_by_policy", "expired", "deleted"].includes(String(row.capture_state))) throw new Error(`capture is ${String(row.capture_state)}`);
  const handle = await open(join(ledger.directory, "captures", text(row.id), kind === "request" ? "request.json" : "response.body"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0 || info.nlink !== 1) throw new Error("unsafe or oversized payload archive");
    const bytes = await handle.readFile(), expected = row[kind === "request" ? "request_sha256" : "response_sha256"];
    if (expected !== null && expected !== undefined && expected !== hash(bytes)) throw new Error("capture integrity check failed"); return bytes;
  } finally { await handle.close(); }
}
export async function exportCapture(ledger: RouterLedger, id: string, destination: string): Promise<void> {
  await mkdir(destination, { mode: 0o700 });
  const manifest = captureManifest(ledger, id);
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
  for (const kind of ["request", "response"] as const) {
    try { await writeFile(join(destination, `${kind}.body`), await captureBody(ledger, id, kind), { mode: 0o600, flag: "wx" }); }
    catch (error) { if (!["expired", "deleted", "disabled_by_policy"].includes(String(manifest.capture.state))) throw error; }
  }
  ledger.audit("operator", "capture.export", id);
}
export async function removeCapture(ledger: RouterLedger, id: string, state: "expired" | "deleted"): Promise<void> {
  const row = ledger.request(id); if (row.outcome === "running") throw new Error("cannot remove active capture");
  // Mark first: partial filesystem removal never leaves a complete manifest.
  ledger.expire(id, state); await rm(join(ledger.directory, "captures", text(row.id)), { recursive: true, force: true });
}
