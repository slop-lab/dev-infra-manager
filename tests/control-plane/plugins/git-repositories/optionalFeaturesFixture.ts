import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { configuredNativeGitBundleServer } from "@slop-lab/dim-control-plane-plugin-git-repositories";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { controlPlanePlugin as codeReviewPlugin } from "@slop-lab/dim-control-plane-plugin-code-review";
export const git = promisify(execFile);
export const generationId = "a".repeat(64);
export const token = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
const importer = { hostId: "host-a", username: "importer", password: token(1) };
const writer = { hostId: "host-a", username: "writer", password: token(2) };
export const reviewer = { reviewerId: "owner", username: "reviewer", password: token(3) };
export const basic = (credential: { username: string; password: string }) => `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
export function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object"); return Object.fromEntries(Object.entries(value)); }
export function text(value: Record<string, unknown>, key: string): string { const result = value[key]; if (typeof result !== "string") throw new Error(`missing ${key}`); return result; }

export async function fixture(withReview: boolean, extraExtensions: readonly ControlPlaneExtension[] = [], reviewPolicy: unknown = { requiredReviewerIds: ["owner"], pathReviewerRules: [] }, humanReviewers = [reviewer], additionalPolicies: Readonly<Record<string, unknown>> = {}, branches?: { readonly defaultRef: string; readonly branches: Readonly<Record<string, { readonly review: boolean }>> }, importRef = "refs/heads/main") {
  const root = await mkdtemp(join(tmpdir(), "dim-optional-git-"));
  const source = join(root, "source");
  const version = /git version (\d+\.\d+\.\d+)/.exec((await git("/usr/bin/git", ["--version"])).stdout)?.[1];
  if (version === undefined) throw new Error("Git version is missing");
  const prepared = withReview ? await codeReviewPlugin.configure({ humanReviewers }) : undefined;
  const options: Parameters<typeof configuredNativeGitBundleServer>[0] = { config: { schemaVersion: 7, serviceId: "native-main", host: "0.0.0.0", port: 8080, storageRoot: "/var/lib/dim-native-git", gitExecutable: "/usr/bin/git", gitVersion: version, projectRegistrars: [], projectRootImporters: [importer], projectRootReadIssuers: [], workspaceWriteIssuers: [writer] }, stateDirectory: join(root, "state"), expectedGenerationId: generationId, readinessToken: token(4), activationToken: token(5), extensions: [...(prepared?.extensions ?? []), ...extraExtensions] };
  const service = await configuredNativeGitBundleServer(options);
  try {
    const origin = await service.listen("127.0.0.1", 0);
    const activated = await fetch(`${origin}/v1/activation`, { method: "POST", headers: { authorization: `Bearer ${token(5)}`, "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId }) });
    assert.equal(activated.status, 200);
    await service.prepareProject(generationId, importer.hostId, { serviceId: "native-main", projectId: "project", repositoryId: "main" });
    await git("/usr/bin/git", ["init", `--initial-branch=${importRef.slice("refs/heads/".length)}`, source]);
    await writeFile(join(source, "README.md"), "initial\n");
    await git("/usr/bin/git", ["-C", source, "add", "."]);
    const commit = async () => { await git("/usr/bin/git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-am", "change"]); return (await git("/usr/bin/git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim(); };
    const initial = await commit();
    const bundle = join(root, "initial.bundle");
    await git("/usr/bin/git", ["-C", source, "bundle", "create", bundle, importRef]);
    const extensions = { ...(withReview ? { "code-review": reviewPolicy } : {}), ...additionalPolicies };
    const policy = { schemaVersion: 1, protectedRef: importRef, ...branches, policyRevision: nativeRepositoryPolicyRevision({ protectedRef: importRef, extensions, ...branches }), extensions };
    const prelude = { schemaVersion: 1, serviceId: "native-main", generationId, projectId: "project", repositoryId: "main", protectedRef: importRef, expectedCommit: initial, policy };
    const uploaded = await fetch(`${origin}/v1/projects/project/repositories/main/import`, { method: "POST", headers: { authorization: basic(importer), "content-type": "application/octet-stream" }, body: Buffer.concat([Buffer.from(`${JSON.stringify(prelude)}\n`), await readFile(bundle)]) });
    assert.equal(uploaded.status, 200, await uploaded.clone().text());
    const uploadedBody = record(await uploaded.json());
    const receipt = { importNonce: text(uploadedBody, "importNonce"), policyDigest: text(uploadedBody, "policyDigest"), bundleDigest: text(uploadedBody, "bundleDigest"), bundleSize: uploadedBody.bundleSize };
    if (typeof receipt.bundleSize !== "number") throw new Error("bundle size is missing");
    const finalized = await fetch(`${origin}/v1/projects/project/repositories/main/import/finalize`, { method: "POST", headers: { authorization: basic(importer), "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest }) });
    assert.equal(finalized.status, 200, await finalized.clone().text());
    const workspaceId = token(6);
    const leased = await fetch(`${origin}/v1/projects/project/repositories/main/workspace-write-leases`, { method: "POST", headers: { authorization: basic(writer), "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "main", workspaceId }) });
    assert.equal(leased.status, 201, await leased.clone().text());
    const leaseBody = record(await leased.json());
    const lease = { username: text(leaseBody, "username"), password: text(leaseBody, "password") };
    const remote = new URL(`/v1/projects/project/repositories/main.git`, origin); remote.username = lease.username; remote.password = lease.password;
    await git("/usr/bin/git", ["-C", source, "remote", "add", "origin", remote.toString()]);
    return { options, extensions: [...(prepared?.extensions ?? []), ...extraExtensions], root, source, service, origin, initial, proposalRef: `refs/heads/proposals/${workspaceId}/change`, commit };
  } catch (error) { await service.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
