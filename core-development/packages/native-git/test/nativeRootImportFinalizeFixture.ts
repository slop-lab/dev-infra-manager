import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { parseNativeGitBundleConfig } from "../../../../core/packages/native-git/src/bundle-config.js";
import {
  configuredNativeGitBundleServer,
  type NativeGitBundleServer
} from "../../../../core/packages/native-git/src/native-bundle-server.js";
import type { AdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import type { ReviewPublicationFaults } from "../../../../core/packages/native-git/src/review-record-storage.js";
import type {
  AuthoritativeNativeReviewHooks
} from "../../../../core/packages/native-git/src/authoritative-native-review.js";
import type { NativeHumanReviewerHooks } from "../../../../core/packages/native-git/src/native-human-reviewer-http.js";
import { bundleSecrets, idleNativeConfig } from "./bundleConfigFixture.js";
import type {
  GitBundle,
  ImportReceipt,
  RootReadLeaseHooks,
  RunningService,
  RuntimeGit,
  WorkspaceWriteLeaseHooks
} from "./nativeRootImportFinalizeTypes.js";

export type { GitBundle, ImportReceipt, RootReadLeaseHooks, RunningService, RuntimeGit,
  WorkspaceWriteLeaseHooks } from "./nativeRootImportFinalizeTypes.js";

export const runGit = promisify(execFile);
export const generationId = "a".repeat(64);
export const activationToken = Buffer.alloc(32, 42).toString("base64url");
export const generationB = "b".repeat(64);
export const activationTokenB = Buffer.alloc(32, 43).toString("base64url");
export const importer = {
  hostId: "host-a", username: "project-root-importer-a", password: bundleSecrets.projectRootImporter
} as const;
export const authorization = `Basic ${Buffer.from(`${importer.username}:${importer.password}`).toString("base64")}`;
const wrongHostImporter = {
  hostId: "host-b", username: "project-root-importer-b", password: Buffer.alloc(32, 56).toString("base64url")
} as const;
export const wrongHostAuthorization = `Basic ${Buffer.from(
  `${wrongHostImporter.username}:${wrongHostImporter.password}`
).toString("base64")}`;
export const rootReadIssuer = {
  hostId: "host-a", username: "project-root-read-issuer-a", password: bundleSecrets.projectRootReadIssuer
} as const;
export const rootReadIssuerAuthorization = `Basic ${Buffer.from(
  `${rootReadIssuer.username}:${rootReadIssuer.password}`
).toString("base64")}`;
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
const roots: string[] = [];
const services: NativeGitBundleServer[] = [];

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
  deliveryFaults?: ReviewPublicationFaults
): Promise<RunningService> {
  return startFinalizeServiceForGeneration(
    root, generationId, activationToken, rootReadLeaseClock, rootReadLeaseHooks, workspaceWriteLeaseClock,
    workspaceWriteLeaseHooks, runtimeGit, authoritativeReviewHooks, nativeHumanReviewerHooks, ordinaryIdentityHttpClient,
    deliveryFaults
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
  deliveryFaults?: ReviewPublicationFaults
): Promise<RunningService> {
  const options = {
    config: parseNativeGitBundleConfig({
      ...idleNativeConfig(),
      ...(runtimeGit === undefined ? {} : runtimeGit),
      projectRegistrars: [{ hostId: "host-a", username: "registrar-a", password: bundleSecrets.projectRegistrar }],
      projectRootImporters: [importer, wrongHostImporter],
      projectRootReadIssuers: [rootReadIssuer, wrongHostRootReadIssuer],
      workspaceWriteIssuers: [workspaceWriteIssuer],
      humanReviewers: [humanReviewer, foreignHumanReviewer]
    }),
    stateDirectory: root,
    readinessToken: Buffer.alloc(32, 41).toString("base64url"),
    activationToken: servingActivationToken,
    expectedGenerationId: servingGenerationId,
    ...(rootReadLeaseClock === undefined ? {} : { rootReadLeaseClock }),
    ...(rootReadLeaseHooks === undefined ? {} : { rootReadLeaseHooks }),
    ...(workspaceWriteLeaseClock === undefined ? {} : { workspaceWriteLeaseClock }),
    ...(workspaceWriteLeaseHooks === undefined ? {} : { workspaceWriteLeaseHooks }),
    ...(authoritativeReviewHooks === undefined ? {} : { authoritativeReviewHooks }),
    ...(nativeHumanReviewerHooks === undefined ? {} : { nativeHumanReviewerHooks }),
    ...(ordinaryIdentityHttpClient === undefined ? {} : { ordinaryIdentityHttpClient }),
    ...(deliveryFaults === undefined ? {} : { deliveryFaults })
  };
  const service = await configuredNativeGitBundleServer(options);
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

export async function activateFinalizeServiceForGeneration(
  origin: string,
  servingGenerationId: string,
  servingActivationToken: string
): Promise<void> {
  const response = await fetch(`${origin}/v1/activation`, {
    method: "POST",
    headers: { authorization: `Bearer ${servingActivationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId: servingGenerationId })
  });
  expect(response.status).toBe(200);
}

export async function closeFinalizeService(service: NativeGitBundleServer): Promise<void> {
  const index = services.findIndex((candidate) => candidate.server === service.server);
  if (index >= 0) services.splice(index, 1);
  await service.close();
}

export async function uploadRootBundle(origin: string, bundle: GitBundle, policy: object = importPolicy()): Promise<Response> {
  const prelude = {
    schemaVersion: 1, generationId, serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root",
    protectedRef: "refs/heads/main", expectedCommit: bundle.commit, policy
  } as const;
  const body = Buffer.concat([Buffer.from(`${JSON.stringify(prelude)}\n`), bundle.bytes]);
  return fetch(`${origin}/v1/projects/project-a/root-import`, {
    method: "POST",
    headers: { authorization, "content-type": "application/octet-stream", "content-length": String(body.length) },
    body
  });
}

export async function finalizeRootImport(
  origin: string,
  selector: object,
  suppliedAuthorization = authorization
): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/root-import/finalize`, {
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

export function projectInput(projectId: string) {
  return { serviceId: "native-main", projectId, rootRepositoryId: "root" } as const;
}

export function rootRepository(root: string): string {
  return join(root, "project-a", "root.git");
}

export function parseImportReceipt(value: unknown): ImportReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Reflect.get(value, "schemaVersion") !== 1
    || Reflect.get(value, "serviceId") !== "native-main"
    || Reflect.get(value, "rootRepositoryId") !== "root"
    || Reflect.get(value, "phase") !== "bundle-durable") {
    throw new Error("invalid root import receipt fixture");
  }
  const projectId = stringField(value, "projectId");
  const receiptGeneration = stringField(value, "generationId");
  const importNonce = stringField(value, "importNonce");
  const protectedRef = stringField(value, "protectedRef");
  const expectedCommit = stringField(value, "expectedCommit");
  const policyDigest = stringField(value, "policyDigest");
  const bundleDigest = stringField(value, "bundleDigest");
  const bundleSize = Reflect.get(value, "bundleSize");
  if (typeof bundleSize !== "number") throw new Error("invalid root import receipt fixture");
  return {
    schemaVersion: 1,
    serviceId: "native-main",
    projectId,
    rootRepositoryId: "root",
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
  return {
    schemaVersion: 1, protectedRef: "refs/heads/main",
    policyRevision: "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
    requiredReviewRevision: "02b474b992388d574069fe2806c9a918f3c660053df4ab6baf595d9d178ea824",
    requiredJobSetRevision: "b9763406fad20f0f816d6346d69d27eb953d7053301bd87275ba73b1f82bc8a1",
    requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }],
    requiredReviewerIds: ["owner"],
    pathReviewerRules: []
  } as const;
}

function stringField(value: object, field: string): string {
  const selected = Reflect.get(value, field);
  if (typeof selected !== "string") throw new Error("invalid root import receipt fixture");
  return selected;
}
