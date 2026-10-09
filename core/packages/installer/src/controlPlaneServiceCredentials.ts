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
  ordinaryValue: unknown
): ServiceConfigurationValues {
  const native = exactRecord(nativeValue, [
    "schemaVersion", "serviceId", "host", "port", "storageRoot", "gitExecutable", "gitVersion",
    "repositories", "identities", "projectRegistrars", "projectRootImporters", "projectRootReadIssuers",
    "workspaceWriteIssuers", "humanReviewers", "ordinaryCi"
  ], "native Git service config");
  if (native.schemaVersion !== 7 || native.serviceId !== "native-main" || native.host !== "0.0.0.0"
    || native.port !== 8080 || native.storageRoot !== "/var/lib/dim-native-git"
    || !Array.isArray(native.repositories) || native.repositories.length !== 0
    || !Array.isArray(native.identities) || native.identities.length !== 0) {
    throw new ControlPlaneSourceError("native Git service config is not a bundle schema-7 config");
  }
  const projectRegistrars = hostCredentials(native.projectRegistrars, "native Git Project registrar");
  const projectRootImporters = hostCredentials(native.projectRootImporters, "native Git Project root importer");
  const projectRootReadIssuers = hostCredentials(native.projectRootReadIssuers, "native Git Project root read issuer");
  const workspaceWriteIssuers = hostCredentials(native.workspaceWriteIssuers, "native Git workspace write issuer");
  const humanReviewers = reviewerCredentials(native.humanReviewers);
  assertDistinct(projectRootImporters.map((entry) => entry.hostId));
  assertDistinct(projectRootReadIssuers.map((entry) => entry.hostId));
  assertDistinct(workspaceWriteIssuers.map((entry) => entry.hostId));
  assertDistinct(humanReviewers.map((entry) => entry.reviewerId));

  const nativeOrdinary = exactRecord(native.ordinaryCi, [
    "endpoint", "serviceId", "query", "identity", "attemptIssuer", "resultReporter", "webhook"
  ], "native Git ordinary CI config");
  const nativeRoles = ["query", "identity", "attemptIssuer", "resultReporter", "webhook"] as const;
  const nativeCredentials = nativeRoles.map((role) => credential(nativeOrdinary[role], `native Git ${role}`));
  const ordinary = exactRecord(ordinaryValue, [
    "schemaVersion", "serviceId", "database", "admissionLeaseMilliseconds", "claimLeaseMilliseconds",
    "nativeGit", "credentials", "hosts"
  ], "ordinary CI service config");
  if (ordinary.schemaVersion !== 4 || ordinary.serviceId !== "ordinary-main"
    || ordinary.database !== "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3") {
    throw new ControlPlaneSourceError("ordinary CI service config is not a bundle schema-4 config");
  }
  const ordinaryNative = exactRecord(ordinary.nativeGit,
    ["endpoint", "serviceId", "identity", "attemptIssuer", "resultReporter"], "ordinary CI native Git config");
  const roles = exactRecord(ordinary.credentials, ["webhook", "registrar", "query"], "ordinary CI credentials");
  const ordinaryCredentials = [
    credential(roles.webhook, "ordinary CI webhook"), credential(roles.registrar, "ordinary CI registrar"),
    credential(roles.query, "ordinary CI query"), credential(ordinaryNative.identity, "ordinary CI identity"),
    credential(ordinaryNative.attemptIssuer, "ordinary CI attempt issuer"),
    credential(ordinaryNative.resultReporter, "ordinary CI result reporter")
  ];
  assertPaired(nativeCredentials, ordinaryCredentials);
  if (!Array.isArray(ordinary.hosts) || ordinary.hosts.length === 0) {
    throw new ControlPlaneSourceError("ordinary CI service config must contain host credentials");
  }
  const hosts = ordinary.hosts.map((host, index) => {
    const value = exactRecord(host, ["hostId", "hostToken", "capacities"], `ordinary CI host ${index}`);
    if (typeof value.hostId !== "string" || !identifierPattern.test(value.hostId) || !isToken(value.hostToken)) {
      throw new ControlPlaneSourceError(`ordinary CI host ${index} identity or token is invalid`);
    }
    return { hostId: value.hostId, hostToken: value.hostToken };
  });
  const hostBoundCredentials = [
    ...projectRegistrars, ...projectRootImporters, ...projectRootReadIssuers, ...workspaceWriteIssuers
  ];
  if (hostBoundCredentials.some((entry) => hosts.some((host) =>
    host.hostId === entry.username || host.hostId === entry.password))) {
    throw new ControlPlaneSourceError("control-plane credential and token values must be distinct");
  }
  const registrar = ordinaryCredentials[1];
  if (registrar === undefined) throw new ControlPlaneSourceError("ordinary CI registrar credential is missing");
  const credentialValues = [
    ...nativeCredentials.map((entry) => entry.password),
    registrar.password,
    ...hosts.map((entry) => entry.hostToken),
    ...hostBoundCredentials.map((entry) => entry.password),
    ...humanReviewers.map((entry) => entry.password)
  ];
  const roleValues = [
    ...nativeCredentials.flatMap((entry) => [entry.username, entry.password]),
    registrar.username,
    registrar.password,
    ...hosts.map((entry) => entry.hostToken),
    ...projectRegistrars.flatMap((entry) => [entry.hostId, entry.username, entry.password]),
    ...projectRootImporters.flatMap((entry) => [entry.username, entry.password]),
    ...projectRootReadIssuers.flatMap((entry) => [entry.username, entry.password]),
    ...workspaceWriteIssuers.flatMap((entry) => [entry.username, entry.password]),
    ...humanReviewers.flatMap((entry) => [entry.reviewerId, entry.username, entry.password])
  ];
  assertDistinct(roleValues);
  return { credentialValues, roleValues };
}

type HostCredential = Credential & { readonly hostId: string };
type ReviewerCredential = Credential & { readonly reviewerId: string };

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
  const input = exactRecord(value, value !== null && typeof value === "object" && Object.hasOwn(value, "endpoint")
    ? ["endpoint", "username", "password"] : ["username", "password"], label);
  if (typeof input.username !== "string" || !isToken(input.password)) {
    throw new ControlPlaneSourceError(`${label} credential is invalid`);
  }
  return { username: input.username, password: input.password };
}

function assertPaired(native: readonly Credential[], ordinary: readonly Credential[]): void {
  const pairs = [[0, 2], [1, 3], [2, 4], [3, 5], [4, 0]] as const;
  for (const [nativeIndex, ordinaryIndex] of pairs) {
    const left = native[nativeIndex];
    const right = ordinary[ordinaryIndex];
    if (left === undefined || right === undefined || left.username !== right.username || left.password !== right.password) {
      throw new ControlPlaneSourceError("native Git and ordinary CI paired credentials must match");
    }
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
