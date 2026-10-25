import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { isExitError } from "../../../support/gitHelpers.js";
import {
  activateFinalizeService,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootRepository,
  runGit,
  startFinalizeService,
  uploadRootBundle,
  workspaceWriteIssuerAuthorization,
  type RunningService,
  type WorkspaceWriteLeaseHooks
} from "./nativeRootImportFinalizeFixture.js";

export const workspaceId = Buffer.alloc(32, 60).toString("base64url");

export async function finalizedWorkspaceWriteFixture(
  label: string,
  workspaceWriteClock?: () => number,
  workspaceWriteHooks?: WorkspaceWriteLeaseHooks
): Promise<{ readonly root: string; readonly service: RunningService }> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root, undefined, undefined, workspaceWriteClock, workspaceWriteHooks);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
  expect((await finalizeRootImport(service.origin, {
    schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest
  })).status).toBe(200);
  return { root, service };
}

export async function issueWorkspaceWriteLease(origin: string): Promise<WorkspaceWriteLease> {
  const response = await fetch(`${origin}/v1/projects/project-a/repositories/root/workspace-write-leases`, {
    method: "POST",
    headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId })
  });
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TestSetupError();
  const username = Reflect.get(value, "username");
  const password = Reflect.get(value, "password");
  const expiresAt = Reflect.get(value, "expiresAt");
  const issuedAt = Reflect.get(value, "issuedAt");
  const preIssueMilliseconds = Reflect.get(value, "preIssueMilliseconds");
  if (typeof username !== "string" || typeof password !== "string" || typeof expiresAt !== "number" || typeof issuedAt !== "number" || typeof preIssueMilliseconds !== "number") {
    throw new TestSetupError();
  }
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(value).toEqual({ schemaVersion: 2, serviceId: "native-main", projectId: "project-a",
    repositoryId: "root", generationId, workspaceId, username, password, issuedAt, expiresAt, preIssueMilliseconds });
  expect(expiresAt - issuedAt).toBe(30_000);
  return { username, password, expiresAt };
}

export async function writerClone(origin: string, lease: WorkspaceWriteLease, label: string): Promise<string> {
  const clone = await createFinalizeRoot(label);
  await runGit("/usr/bin/git", ["clone", authenticatedRemote(origin, lease), clone]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.name", "DIM writer"]);
  await runGit("/usr/bin/git", ["-C", clone, "config", "user.email", "writer@example.invalid"]);
  return clone;
}

export async function commit(clone: string, file: string, contents: string): Promise<void> {
  await mkdir(clone, { recursive: true });
  await writeFile(join(clone, file), contents);
  await runGit("/usr/bin/git", ["-C", clone, "add", file]);
  await runGit("/usr/bin/git", ["-C", clone, "commit", "-m", file]);
}

export async function expectRejectedPush(clone: string, refspec: readonly string[]): Promise<void> {
  await expect(runGit("/usr/bin/git", ["-C", clone, "push", "origin", ...refspec]))
    .rejects.toSatisfy((error: unknown) => isExitError(error) && /remote rejected/.test(error.stderr));
}

export async function expectWorkspaceWriteCloneRejected(
  origin: string,
  lease: WorkspaceWriteLease,
  label: string
): Promise<void> {
  const clone = await createFinalizeRoot(label);
  await expect(runGit("/usr/bin/git", ["clone", authenticatedRemote(origin, lease), clone]))
    .rejects.toSatisfy((error: unknown) => isExitError(error));
}

export async function refValue(root: string, ref: string): Promise<string | undefined> {
  try {
    return (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root), "rev-parse", "--verify", ref]))
      .stdout.trim();
  } catch (error) {
    if (isExitError(error)) return undefined;
    throw error;
  }
}

export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function authenticatedRemote(origin: string, lease: WorkspaceWriteLease): string {
  const url = new URL("/v1/projects/project-a/repositories/root.git", origin);
  url.username = lease.username;
  url.password = lease.password;
  return url.toString();
}

type WorkspaceWriteLease = {
  readonly username: string;
  readonly password: string;
  readonly expiresAt: number;
};

class TestSetupError extends Error {
  readonly name = "TestSetupError";
}
