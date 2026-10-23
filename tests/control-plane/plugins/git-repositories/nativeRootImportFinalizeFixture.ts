import { gitPolicy, managedPolicyExtensions } from "../../../support/git-policy.js";
import { dimWorkflowCompiler } from "@slop-lab/dim-control-plane-plugin-ci-workflows";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseManagedGitServiceConfig } from "@slop-lab/dim-control-plane-admin/service-pair";
import { configuredManagedGitFixture, type ManagedGitFixture } from "../../../support/managed-git-service.js";
import type { NativeGitAdmissionHttpClient as AdmissionVerifierHttpClient } from "../../../../packages/contracts/git/src/http.js";
import type { CiDeliveryPublicationFaults } from "../../../../packages/control-plane/plugins/git-ci/src/delivery-publication.js";
import type { AuthoritativeNativeReviewHooks } from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review.js";
import type { NativeHumanReviewerHooks } from "../../../../packages/control-plane/plugins/git-review/src/native-human-reviewer-http.js";
import { bundleSecrets, idleNativeConfig } from "./bundleConfigFixture.js";
import type { GitBundle, ImportReceipt, RootReadLeaseHooks, RunningService, RuntimeGit, WorkspaceWriteLeaseHooks } from "./nativeRootImportFinalizeTypes.js";

export type { GitBundle, ImportReceipt, RootReadLeaseHooks, RunningService, RuntimeGit, WorkspaceWriteLeaseHooks } from "./nativeRootImportFinalizeTypes.js";

export const runGit = promisify(execFile);
export const generationId = "a".repeat(64);
export const activationToken = Buffer.alloc(32, 42).toString("base64url");
export const finalizeReadinessToken = Buffer.alloc(32, 41).toString("base64url");
export const generationB = "b".repeat(64);
export const activationTokenB = Buffer.alloc(32, 43).toString("base64url");
export const importer = {
  hostId: "host-a", username: "project-root-importer-a", password: bundleSecrets.projectRootImporter
} as const;
export const authorization = `Basic ${Buffer.from(`${importer.username}:${importer.password}`).toString("base64")}`;
const wrongHostImporter = {
  hostId: "host-b", username: "project-root-importer-b", password: Buffer.alloc(32, 56).toString("base64url")
} as const;
export const wrongHostAuthorization = `Basic ${Buffer.from(`${wrongHostImporter.username}:${wrongHostImporter.password}`).toString("base64")}`;
export const rootReadIssuer = {
  hostId: "host-a", username: "project-root-read-issuer-a", password: bundleSecrets.projectRootReadIssuer
} as const;
export const rootReadIssuerAuthorization = `Basic ${Buffer.from(`${rootReadIssuer.username}:${rootReadIssuer.password}`).toString("base64")}`;
export const wrongHostRootReadIssuer = {
  hostId: "host-b", username: "project-root-read-issuer-b", password: Buffer.alloc(32, 57).toString("base64url")
} as const;
export const workspaceWriteIssuer = {
  hostId: "host-a", username: "workspace-write-issuer-a", password: bundleSecrets.workspaceWriteIssuer
} as const;
export const workspaceWriteIssuerAuthorization = `Basic ${Buffer.from(
  `${workspaceWriteIssuer.username}:${workspaceWriteIssuer.password}`
).toString("base64")}`;
export const humanReviewer = {
  reviewerId: "owner", username: "human-reviewer-owner", password: bundleSecrets.humanReviewer
} as const;
export const humanReviewerAuthorization = `Basic ${Buffer.from(
  `${humanReviewer.username}:${humanReviewer.password}`
).toString("base64")}`;
export const foreignHumanReviewer = {
  reviewerId: "foreign", username: "human-reviewer-foreign", password: bundleSecrets.foreignHumanReviewer
} as const;
export const hostPromoter = {
  hostId: "host-a", username: "host-promoter-a", password: bundleSecrets.hostPromoter
} as const;
export const hostPromoterAuthorization = `Basic ${Buffer.from(
  `${hostPromoter.username}:${hostPromoter.password}`
).toString("base64")}`;
export const foreignHostPromoter = {
  hostId: "host-b", username: "host-promoter-b", password: Buffer.alloc(32, 58).toString("base64url")
} as const;
export const foreignHostPromoterAuthorization = `Basic ${Buffer.from(
  `${foreignHostPromoter.username}:${foreignHostPromoter.password}`
).toString("base64")}`;
const roots: string[] = [];
const services: ManagedGitFixture[] = [];

export async function cleanupFinalizeFixtures(): Promise<void> {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function createFinalizeRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dim-native-root-${label}-`));
  roots.push(root);
  return root;
}

export async function startFinalizeService(
  root: string,
  rootReadLeaseClock?: () => number,
  rootReadLeaseHooks?: RootReadLeaseHooks,
  workspaceWriteLeaseClock?: () => number,
  workspaceWriteLeaseHooks?: WorkspaceWriteLeaseHooks,
  runtimeGit?: RuntimeGit,
  authoritativeReviewHooks?: AuthoritativeNativeReviewHooks,
  nativeHumanReviewerHooks?: NativeHumanReviewerHooks,
  ordinaryIdentityHttpClient?: AdmissionVerifierHttpClient,
  deliveryFaults?: CiDeliveryPublicationFaults,
  nativeOrdinaryAttemptHooks?: undefined,
  configOverrides: object = {}
): Promise<RunningService> {
  return startFinalizeServiceForGeneration(
    root, generationId, activationToken, rootReadLeaseClock, rootReadLeaseHooks, workspaceWriteLeaseClock,
    workspaceWriteLeaseHooks, runtimeGit, authoritativeReviewHooks, nativeHumanReviewerHooks, ordinaryIdentityHttpClient,
    deliveryFaults, nativeOrdinaryAttemptHooks, configOverrides
  );
}

export async function startFinalizeServiceForGeneration(
  root: string,
  servingGenerationId: string,
  servingActivationToken: string,
  rootReadLeaseClock?: () => number,
  rootReadLeaseHooks?: RootReadLeaseHooks,
  workspaceWriteLeaseClock?: () => number,
  workspaceWriteLeaseHooks?: WorkspaceWriteLeaseHooks,
  runtimeGit?: RuntimeGit,
  authoritativeReviewHooks?: AuthoritativeNativeReviewHooks,
  nativeHumanReviewerHooks?: NativeHumanReviewerHooks,
  ordinaryIdentityHttpClient?: AdmissionVerifierHttpClient,
  deliveryFaults?: CiDeliveryPublicationFaults,
  nativeOrdinaryAttemptHooks?: undefined,
  configOverrides: object = {}
): Promise<RunningService> {
  const options = {
    workflowCompiler: dimWorkflowCompiler,
    config: parseManagedGitServiceConfig({
      ...idleNativeConfig(),
      ...configOverrides,
      ...(runtimeGit === undefined ? {} : runtimeGit),
      projectRegistrars: [{ hostId: "host-a", username: "registrar-a", password: bundleSecrets.projectRegistrar }],
      projectRootImporters: [importer, wrongHostImporter],
      projectRootReadIssuers: [rootReadIssuer, wrongHostRootReadIssuer],
      workspaceWriteIssuers: [workspaceWriteIssuer],
      humanReviewers: [humanReviewer, foreignHumanReviewer],
      hostPromoters: [hostPromoter, foreignHostPromoter]
    }),
    stateDirectory: root,
    readinessToken: finalizeReadinessToken,
    activationToken: servingActivationToken,
    expectedGenerationId: servingGenerationId,
    ...(rootReadLeaseClock === undefined ? {} : { rootReadLeaseClock, executionReadLeaseClock: rootReadLeaseClock }),
    ...(rootReadLeaseHooks === undefined ? {} : { rootReadLeaseHooks }),
    ...(workspaceWriteLeaseClock === undefined ? {} : { workspaceWriteLeaseClock }),
    ...(workspaceWriteLeaseHooks === undefined ? {} : { workspaceWriteLeaseHooks }),
    ...(authoritativeReviewHooks === undefined ? {} : { authoritativeReviewHooks }),
    ...(nativeHumanReviewerHooks === undefined ? {} : { nativeHumanReviewerHooks }),
    ...(ordinaryIdentityHttpClient === undefined ? {} : { ordinaryIdentityHttpClient }),
    ...(deliveryFaults === undefined ? {} : { deliveryFaults }),
  };
  const service = await configuredManagedGitFixture(options);
  services.push(service);
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", () => {
      service.server.off("error", reject);
      resolve();
    });
  });
  const address = service.server.address();
  if (address === null || typeof address === "string") throw new TypeError("native Git listener is unavailable");
  return { ...service, origin: `http://127.0.0.1:${address.port}` };
}

export async function activateFinalizeService(origin: string): Promise<void> {
  await activateFinalizeServiceForGeneration(origin, generationId, activationToken);
}

export async function activateFinalizeServiceForGeneration(origin: string, servingGenerationId: string,
  servingActivationToken: string): Promise<void> {
  const response = await fetch(`${origin}/v1/activation`, {
    method: "POST",
    headers: { authorization: `Bearer ${servingActivationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId: servingGenerationId })
  });
  if (response.status !== 200) {
    throw new TypeError(`native finalize service activation returned ${String(response.status)}`);
  }
}

export async function closeFinalizeService(service: ManagedGitFixture): Promise<void> {
  const index = services.findIndex((candidate) => candidate.server === service.server);
  if (index >= 0) services.splice(index, 1);
  await service.close();
}

export async function uploadRootBundle(origin: string, bundle: GitBundle, policy: object = importPolicy(), repositoryId = "root"): Promise<Response> {
  const prelude = {
    schemaVersion: 1, generationId, serviceId: "native-main", projectId: "project-a", repositoryId,
    protectedRef: "refs/heads/main", expectedCommit: bundle.commit, policy
  } as const;
  const body = Buffer.concat([Buffer.from(`${JSON.stringify(prelude)}\n`), bundle.bytes]);
  return fetch(`${origin}/v1/projects/project-a/repositories/${repositoryId}/import`, {
    method: "POST",
    headers: { authorization, "content-type": "application/octet-stream", "content-length": String(body.length) },
    body
  });
}

export async function finalizeRootImport(
  origin: string,
  selector: object,
  suppliedAuthorization = authorization,
  repositoryId = "root"
): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/repositories/${repositoryId}/import/finalize`, {
    method: "POST",
    headers: { authorization: suppliedAuthorization, "content-type": "application/json" },
    body: JSON.stringify(selector)
  });
}

export async function createRootBundle(
  files: Readonly<Record<string, string>> = { "README.md": "root bundle\n" }
): Promise<GitBundle> {
  const root = await createFinalizeRoot("bundle");
  const source = join(root, "source");
  const path = join(root, "root.bundle");
  await runGit("/usr/bin/git", ["init", "--initial-branch=main", source]);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(source, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }
  await runGit("/usr/bin/git", ["-C", source, "add", "."]);
  await runGit("/usr/bin/git", ["-C", source, "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
    "commit", "-m", "root"]);
  const commit = (await runGit("/usr/bin/git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const tree = (await runGit("/usr/bin/git", ["-C", source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  await runGit("/usr/bin/git", ["-C", source, "bundle", "create", path, "refs/heads/main"]);
  return { bytes: await readFile(path), commit, tree };
}

export function projectInput(projectId: string, repositoryId = "root") {
  return { serviceId: "native-main", projectId, repositoryId } as const;
}

export function rootRepository(root: string, repositoryId = "root"): string {
  return join(root, "project-a", `${repositoryId}.git`);
}

export function parseImportReceipt(value: unknown): ImportReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Reflect.get(value, "schemaVersion") !== 1
    || Reflect.get(value, "serviceId") !== "native-main"
    || Reflect.get(value, "phase") !== "bundle-durable") {
    throw new Error(`invalid root import receipt fixture: ${JSON.stringify(value)}`);
  }
  const projectId = stringField(value, "projectId");
  const repositoryId = stringField(value, "repositoryId");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(repositoryId)) throw new Error("invalid repository identity");
  const receiptGeneration = stringField(value, "generationId");
  const importNonce = stringField(value, "importNonce");
  const protectedRef = stringField(value, "protectedRef");
  const expectedCommit = stringField(value, "expectedCommit");
  const policyDigest = stringField(value, "policyDigest");
  const bundleDigest = stringField(value, "bundleDigest");
  const bundleSize = Reflect.get(value, "bundleSize");
  if (typeof bundleSize !== "number") throw new Error(`invalid root import receipt fixture: ${JSON.stringify(value)}`);
  return {
    schemaVersion: 1,
    serviceId: "native-main",
    projectId,
    repositoryId,
    generationId: receiptGeneration,
    importNonce,
    protectedRef,
    expectedCommit,
    policyDigest,
    bundleDigest,
    bundleSize,
    phase: "bundle-durable"
  };
}

function importPolicy() {
  return gitPolicy(managedPolicyExtensions({ jobs: [{ name: "source", kind: "ordinary-sysbox" }] }));
}

function stringField(value: object, field: string): string {
  const selected = Reflect.get(value, field);
  if (typeof selected !== "string") throw new Error(`invalid root import receipt fixture: ${JSON.stringify(value)}`);
  return selected;
}
