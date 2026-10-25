import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseNativeControlPlaneConnection } from "../../packages/host/plugins/native-git/src/nativeControlPlaneConnection.ts";
import { parseNativeGitRootImporterConnection } from "../../packages/host/plugins/native-git/src/nativeGitRootImporterConnection.ts";
import { parseNativeGitProjectRegistrarConnection } from "../../packages/host/plugins/native-git/src/nativeGitProjectRegistrarConnection.ts";
import { reviewerConnectionSchema, promoterConnectionSchema } from "../../packages/service-clients/native-git/src/operator.ts";
import { ciQueryConnectionSchema } from "../../packages/contracts/ci/src/connections.ts";
import { executionOperatorConnectionSchema } from "../../packages/contracts/execution/src/connections.ts";
import { executionSummarySchema, executionWorkersSchema } from "../../packages/contracts/ci/src/query.ts";
import { executionWorkerConfigSchema } from "../../packages/contracts/ci/src/worker.ts";
import { createNodeNativeGitAdmissionHttpClient } from "../../packages/contracts/git/src/http.ts";
import { privateJson } from "./files.ts";

export interface ExistingConnections {
  readonly files: Readonly<Record<string, unknown>>;
  readonly hostId: string;
  readonly generationId: string;
  readonly nativeEndpoint: string;
  readonly executionEndpoint: string;
  readonly identities: readonly { endpoint: string; path: string; username: string; password: string; expected?: Readonly<Record<string, unknown>> }[];
}
const required = ["host.json", "importer.json", "registrar.json", "reviewer.json", "promoter.json", "ci-query.json", "execution-operator.json"];
const optional = ["git-sync.json", "worker.json"];
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid private connection object");
  return value as Record<string, unknown>;
};
/** Only caller role material is transferable. Never copy service configuration or readiness tokens. */
export async function readExistingConnections(directory: string): Promise<ExistingConnections> {
  if (!isAbsolute(directory)) throw new Error("--connections must be an absolute private directory");
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("connection directory must be private, user-owned and not a symlink (0700)");
  const names = await readdir(directory);
  if (names.some((name) => ![...required, ...optional].includes(name)) || required.some((name) => !names.includes(name))) throw new Error("connection directory must contain the generated private role connections only");
  const files: Record<string, unknown> = {};
  for (const name of names) files[name] = await privateJson(join(directory, name));
  const host = parseNativeControlPlaneConnection(files["host.json"]);
  const importer = parseNativeGitRootImporterConnection(files["importer.json"]);
  const registrar = parseNativeGitProjectRegistrarConnection(files["registrar.json"]);
  const reviewer = reviewerConnectionSchema.parse(files["reviewer.json"]);
  const promoter = promoterConnectionSchema.parse(files["promoter.json"]);
  const query = ciQueryConnectionSchema.parse(files["ci-query.json"]);
  const operator = executionOperatorConnectionSchema.parse(files["execution-operator.json"]);
  const endpoint = host.nativeGit.endpoint, generationId = host.nativeGit.generationId, hostId = host.hostId;
  if ([importer, registrar, promoter].some((role) => role.endpoint !== endpoint || role.generationId !== generationId || role.hostId !== hostId)
    || reviewer.baseUrl !== endpoint || reviewer.generationId !== generationId
    || query.generationId !== generationId || operator.generationId !== generationId || operator.endpoint !== query.endpoint
    || query.credential.username === operator.credential.username || query.credential.password === operator.credential.password) throw new Error("private connections must select one host and control-plane generation with distinct execution roles");
  const identity = (role: string, credential: { username: string; password: string }, scope: Record<string, unknown> = { hostId }) => ({
    // Registrar identity attests its host authority; the importer on this same
    // endpoint attests the generation. Registrar preparation checks it on write.
    endpoint, path: `/v1/${role}-identity`, ...credential, expected: { schemaVersion: 1, serviceId: "native-main", role,
      ...(role === "operator-project-registrar" ? {} : { generationId }), ...scope }
  });
  const identities: ExistingConnections["identities"][number][] = [
    identity("operator-root-importer", importer.credential), identity("operator-project-registrar", registrar.credential),
    identity("operator-workspace-write-issuer", host.nativeGit.workspaceWriteIssuer),
    identity("human-reviewer", reviewer, { reviewerId: reviewer.reviewerId }), identity("host-promoter", promoter.credential),
    { endpoint: query.endpoint, path: "/v1/jobs", ...query.credential },
    { endpoint: operator.endpoint, path: "/v1/operator/workers", ...operator.credential }
  ];
  if (files["git-sync.json"] !== undefined) {
    const sync = record(files["git-sync.json"]), credential = record(sync.credential);
    if (Object.keys(sync).sort().join() !== "credential,endpoint,generationId,hostId,role,schemaVersion,serviceId"
      || sync.schemaVersion !== 1 || sync.role !== "git-sync-operator" || sync.serviceId !== "native-main" || sync.endpoint !== endpoint || sync.generationId !== generationId || sync.hostId !== hostId
      || Object.keys(credential).sort().join() !== "password,username" || typeof credential.username !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(credential.username)
      || typeof credential.password !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(credential.password)) throw new Error("Git sync connection conflicts with the selected control plane");
    identities.push(identity("git-sync-operator", { username: credential.username, password: credential.password }));
  }
  if (files["worker.json"] !== undefined) {
    const worker = executionWorkerConfigSchema.parse(files["worker.json"]);
    if (worker.generationId !== generationId || worker.endpoint !== query.endpoint || worker.nativeGitEndpoint !== endpoint) throw new Error("execution worker connection conflicts with the selected control plane");
  }
  return { files, hostId, generationId, nativeEndpoint: endpoint, executionEndpoint: query.endpoint, identities };
}
/** Read-only live attestation; no approval, ref update, deployment or worker registration. */
export async function attestExistingConnections(bundle: ExistingConnections): Promise<void> {
  const http = createNodeNativeGitAdmissionHttpClient();
  for (const role of bundle.identities) {
    const response = await http.request({ endpoint: role.endpoint, path: role.path, method: "GET", generationId: bundle.generationId,
      authorization: `Basic ${Buffer.from(`${role.username}:${role.password}`).toString("base64")}`, signal: AbortSignal.timeout(10_000) });
    if (response.statusCode !== 200 || response.contentType !== "application/json" || response.cacheControl !== "no-store" || response.body.length > 1024 * 1024) throw new Error(`existing control-plane attestation failed: ${role.path} (HTTP ${response.statusCode}); check the SSH forward and regenerate stale connections`);
    const value: unknown = JSON.parse(response.body.toString("utf8"));
    if (role.expected && Object.entries(role.expected).some(([key, expected]) => record(value)[key] !== expected)) throw new Error(`existing control-plane identity or generation changed: ${role.path}`);
    if (!role.expected) {
      if (role.path === "/v1/operator/workers") executionWorkersSchema.parse(value);
      else {
        if (!Array.isArray(value) || value.length > 100) throw new Error("invalid existing execution jobs response");
        for (const job of value) executionSummarySchema.parse(job);
      }
    }
  }
}
