import { ControlPlaneSourceError } from "./controlPlaneSourceError.js";

const tokenPattern = /^[A-Za-z0-9_-]+$/;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const usernamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

type Credential = { readonly username: string; readonly password: string };
export type ServiceConfigurationValues = {
  readonly credentialValues: readonly string[];
  readonly roleValues: readonly string[];
};

export function serviceCredentialValues(
  nativeValue: unknown,
  executionValue: unknown
): ServiceConfigurationValues {
  if (!isRecord(nativeValue)) throw new ControlPlaneSourceError("native Git service config must be an object");
  const { gitSync, ...nativeRepository } = nativeValue;
  const native = exactRecord(nativeRepository, [
    "schemaVersion", "serviceId", "host", "port", "storageRoot", "gitExecutable", "gitVersion",
    "projectRegistrars", "projectRootImporters", "projectRootReadIssuers",
    "workspaceWriteIssuers", "humanReviewers", "hostPromoters", "ci"
  ], "native Git service config");
  if (native.schemaVersion !== 7 || native.serviceId !== "native-main" || native.host !== "0.0.0.0"
    || native.port !== 8080 || native.storageRoot !== "/var/lib/dim-native-git") {
    throw new ControlPlaneSourceError("native Git service config is not a bundle schema-7 config");
  }
  const projectRegistrars = hostCredentials(native.projectRegistrars, "native Git Project registrar");
  const projectRootImporters = hostCredentials(native.projectRootImporters, "native Git Project root importer");
  const projectRootReadIssuers = hostCredentials(native.projectRootReadIssuers, "native Git Project root read issuer");
  const workspaceWriteIssuers = hostCredentials(native.workspaceWriteIssuers, "native Git workspace write issuer");
  const humanReviewers = reviewerCredentials(native.humanReviewers);
  const hostPromoters = hostCredentials(native.hostPromoters, "native Git host promoter");
  const synchronization = gitSyncCredentials(gitSync);
  assertDistinct(projectRegistrars.map((entry) => entry.hostId));
  assertDistinct(projectRootImporters.map((entry) => entry.hostId));
  assertDistinct(projectRootReadIssuers.map((entry) => entry.hostId));
  assertDistinct(workspaceWriteIssuers.map((entry) => entry.hostId));
  assertDistinct(humanReviewers.map((entry) => entry.reviewerId));
  assertDistinct(hostPromoters.map((entry) => entry.hostId));

  const sourceRoles = ["grantIssuer", "candidateReader", "resultReporter"] as const;
  const nativeCi = exactRecord(native.ci, [...sourceRoles, "webhook"], "native Git CI config");
  const webhook = exactRecord(nativeCi.webhook, ["endpoint", "username", "password"], "native Git CI webhook");
  if (webhook.endpoint !== "http://execution:8080/v1/jobs") {
    throw new ControlPlaneSourceError("native Git CI webhook endpoint must be http://execution:8080/v1/jobs");
  }
  const execution = exactRecord(executionValue,
    ["schemaVersion", "claimLeaseMilliseconds", "nativeGit", "credentials", "workers"], "Execution service config");
  if (execution.schemaVersion !== 1) {
    throw new ControlPlaneSourceError("Execution service config is not a bundle schema-1 config");
  }
  const executionNative = exactRecord(execution.nativeGit,
    ["endpoint", ...sourceRoles], "CI native Git config");
  if (executionNative.endpoint !== "http://native-git:8080") {
    throw new ControlPlaneSourceError("CI native Git endpoint must be http://native-git:8080");
  }
  const roles = exactRecord(execution.credentials, ["webhook", "query", "operator"], "CI credentials");
  const nativeCredentials = sourceRoles.map((role) => {
    const selected = credential(nativeCi[role], `native Git CI ${role}`);
    assertPaired(selected, credential(executionNative[role], `CI ${role}`));
    return selected;
  });
  const nativeWebhook = credential({ username: webhook.username, password: webhook.password }, "native Git CI webhook");
  assertPaired(nativeWebhook, credential(roles.webhook, "CI webhook"));
  const serviceCredentials = [...nativeCredentials, nativeWebhook, credential(roles.query, "CI query"), credential(roles.operator, "Execution operator")];
  if (!Array.isArray(execution.workers)) {
    throw new ControlPlaneSourceError("Execution service worker credentials must be an array");
  }
  const workers = execution.workers.map((worker, index) => {
    const value = exactRecord(worker, ["id", "token", "slots"], `Execution worker ${index}`);
    if (typeof value.id !== "string" || !identifierPattern.test(value.id) || !isToken(value.token)
      || !Array.isArray(value.slots)) {
      throw new ControlPlaneSourceError(`Execution worker ${index} identity, token or slots are invalid`);
    }
    return { id: value.id, token: value.token };
  });
  const hostBoundCredentials = [
    ...projectRegistrars, ...projectRootImporters, ...projectRootReadIssuers, ...workspaceWriteIssuers, ...hostPromoters, ...synchronization.operators
  ];
  const allCredentials = [...serviceCredentials, ...hostBoundCredentials, ...humanReviewers,
    ...(synchronization.upstream === undefined ? [] : [synchronization.upstream])];
  const credentialValues = [...allCredentials.map((entry) => entry.password), ...workers.map((entry) => entry.token)];
  const roleValues = [
    ...allCredentials.flatMap((entry) => [entry.username, entry.password]),
    ...workers.flatMap((entry) => [entry.id, entry.token])
  ];
  assertDistinct(roleValues);
  const scopeIds = [...hostBoundCredentials.map((entry) => entry.hostId), ...humanReviewers.map((entry) => entry.reviewerId)];
  if (allCredentials.flatMap((entry) => [entry.username, entry.password]).concat(workers.map((entry) => entry.token))
    .some((value) => scopeIds.includes(value))) {
    throw new ControlPlaneSourceError("control-plane credential and token values must be distinct");
  }
  // Scope IDs may intentionally identify the same host across roles or workers.
  return { credentialValues, roleValues: [...new Set([...roleValues, ...scopeIds])] };
}

type HostCredential = Credential & { readonly hostId: string };
type ReviewerCredential = Credential & { readonly reviewerId: string };

function gitSyncCredentials(value: unknown): { operators: readonly HostCredential[]; upstream?: Credential } {
  if (value === undefined) return { operators: [] };
  if (!isRecord(value)) throw new ControlPlaneSourceError("native Git synchronization config must be an object");
  const keys = ["operators", ...(Object.hasOwn(value, "credential") ? ["credential"] : []),
    ...(Object.hasOwn(value, "allowLocalRemotes") ? ["allowLocalRemotes"] : [])];
  const input = exactRecord(value, keys, "native Git synchronization config");
  if (input.allowLocalRemotes !== undefined && typeof input.allowLocalRemotes !== "boolean") {
    throw new ControlPlaneSourceError("native Git synchronization local remotes setting must be a boolean");
  }
  const operators = hostCredentials(input.operators, "native Git synchronization operator");
  assertDistinct(operators.map(({ hostId }) => hostId));
  if (input.credential === undefined) return { operators };
  const upstream = exactRecord(input.credential, ["username", "password"], "native Git synchronization upstream credential");
  if (typeof upstream.username !== "string" || upstream.username.length > 256 || !/^[^:\x00-\x20\x7f]+$/.test(upstream.username)
    || typeof upstream.password !== "string" || upstream.password.length > 4096 || !/^[^\x00-\x20\x7f]+$/.test(upstream.password)) {
    throw new ControlPlaneSourceError("native Git synchronization upstream credential is invalid");
  }
  return { operators, upstream: { username: upstream.username, password: upstream.password } };
}

function reviewerCredentials(value: unknown): readonly ReviewerCredential[] {
  if (!Array.isArray(value)) throw new ControlPlaneSourceError("native Git human reviewers must be an array");
  return value.map((entry, index) => {
    const selected = exactRecord(entry, ["reviewerId", "username", "password"], `native Git human reviewer ${index}`);
    if (typeof selected.reviewerId !== "string" || !identifierPattern.test(selected.reviewerId)
      || typeof selected.username !== "string" || !usernamePattern.test(selected.username)
      || !isToken(selected.password) || Buffer.from(selected.password, "base64url").length !== 32) {
      throw new ControlPlaneSourceError(`native Git human reviewer ${index} is invalid`);
    }
    return { reviewerId: selected.reviewerId, username: selected.username, password: selected.password };
  });
}

function hostCredentials(value: unknown, label: string): readonly HostCredential[] {
  if (!Array.isArray(value)) throw new ControlPlaneSourceError(`${label}s must be an array`);
  return value.map((entry, index) => {
    const selected = exactRecord(entry, ["hostId", "username", "password"], `${label} ${index}`);
    if (typeof selected.hostId !== "string" || !identifierPattern.test(selected.hostId)
      || typeof selected.username !== "string" || !usernamePattern.test(selected.username)
      || !isToken(selected.password) || Buffer.from(selected.password, "base64url").length !== 32) {
      throw new ControlPlaneSourceError(`${label} ${index} is invalid`);
    }
    return { hostId: selected.hostId, username: selected.username, password: selected.password };
  });
}

function credential(value: unknown, label: string): Credential {
  const input = exactRecord(value, ["username", "password"], label);
  if (typeof input.username !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.username) || !isToken(input.password)) {
    throw new ControlPlaneSourceError(`${label} credential is invalid`);
  }
  return { username: input.username, password: input.password };
}

function assertPaired(native: Credential, worker: Credential): void {
  if (native.username !== worker.username || native.password !== worker.password) {
    throw new ControlPlaneSourceError("native Git and CI paired credentials must match");
  }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new ControlPlaneSourceError(`${label} has missing or unknown fields`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  if (typeof value !== "string" || !tokenPattern.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 32 && decoded.toString("base64url") === value;
}

function assertDistinct(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new ControlPlaneSourceError("control-plane credential and token values must be distinct");
  }
}
