import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { bootstrapNativeProjectRoot } from "../../../../core/packages/core/src/index.js";
import type { NativeProjectDraft } from "../../../../core/packages/core/src/nativeProjectDraftCodec.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import { activateFinalizeService, cleanupFinalizeFixtures, createFinalizeRoot, generationId,
  importer, rootReadIssuer, startFinalizeService,
  type RootReadLeaseHooks, type RunningService } from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const run = promisify(execFile);
const roots: string[] = [];

export type NativeProjectDraftRootReadFixture = {
  readonly root: string;
  readonly serviceRoot: string;
  readonly service: RunningService;
  readonly importerConnectionFile: string;
  readonly issuerConnectionFile: string;
  readonly draft: NativeProjectDraft;
  readonly recordPath: string;
  readonly artifactPath: string;
};

export async function cleanupNativeProjectDraftRootReadFixtures(): Promise<void> {
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function nativeProjectDraftRootReadFixture(
  rootReadLeaseHooks?: RootReadLeaseHooks,
  prepareSource?: (sourceRepository: string) => Promise<void>,
  prepareIndex?: (sourceRepository: string) => Promise<void>
): Promise<NativeProjectDraftRootReadFixture> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-draft-root-read-"));
  roots.push(root);
  const scratchRoot = join(root, "scratch");
  const sourceRepository = join(root, "source");
  await mkdir(scratchRoot, { mode: 0o700 });
  await run("/usr/bin/git", ["init", "--initial-branch=main", sourceRepository]);
  await mkdir(join(sourceRepository, ".dim"));
  await writeFile(join(sourceRepository, ".dim/repos.yml"), `schemaVersion: 1
repositories:
  root: {url: https://example.test/root.git, root: true, ref: main, protect: [main]}
nativeReview:
  requiredReviewerIds: [owner]
  pathReviewerRules: []
  requiredJobs: [{name: source, kind: ordinary-sysbox}]
`);
  await writeFile(join(sourceRepository, "README.md"), "trusted imported root\n");
  await prepareSource?.(sourceRepository);
  await run("/usr/bin/git", ["-C", sourceRepository, "add", "."]);
  await prepareIndex?.(sourceRepository);
  await run("/usr/bin/git", ["-C", sourceRepository, "-c", "user.name=DIM Test",
    "-c", "user.email=dim@example.invalid", "commit", "-m", "root"]);
  const serviceRoot = await createFinalizeRoot("draft-root-read-service");
  const service = await startFinalizeService(serviceRoot, undefined, rootReadLeaseHooks);
  await activateFinalizeService(service.origin);
  const registrarConnectionFile = join(root, "registrar.json");
  const importerConnectionFile = join(root, "importer.json");
  const issuerConnectionFile = join(root, "issuer.json");
  await writeConnection(registrarConnectionFile, { schemaVersion: 1, endpoint: service.origin,
    serviceId: "native-main", hostId: importer.hostId, generationId,
    credential: { username: "registrar-a", password: bundleSecrets.projectRegistrar } });
  await writeImporterConnection(importerConnectionFile, service.origin);
  await writeIssuerConnection(issuerConnectionFile, service.origin);
  const draft = await bootstrapNativeProjectRoot({ name: "acme", projectId: "project-a", stateRoot: root,
    scratchRoot, sourceRepository, gitExecutable: "/usr/bin/git", selectedRef: "refs/heads/main",
    policySource: { kind: "reviewed-manifest" }, registrarConnectionFile, importerConnectionFile,
    signal: AbortSignal.timeout(20_000) });
  return { root, serviceRoot, service, importerConnectionFile, issuerConnectionFile, draft,
    recordPath: join(root, "native-project-drafts", "acme.json"),
    artifactPath: join(root, "native-project-drafts", "artifacts", draft.projectId,
      `${draft.bundleDigest}.bundle`) };
}

export async function writeImporterConnection(path: string, endpoint: string,
  change: Readonly<Record<string, unknown>> = {}): Promise<void> {
  await writeConnection(path, { schemaVersion: 1, endpoint, serviceId: "native-main",
    role: "operator-root-importer", hostId: importer.hostId, generationId,
    credential: { username: importer.username, password: importer.password }, ...change });
}

export async function writeIssuerConnection(path: string, endpoint: string,
  change: Readonly<Record<string, unknown>> = {}): Promise<void> {
  await writeConnection(path, { schemaVersion: 1, endpoint, serviceId: "native-main",
    role: "operator-root-read-issuer", hostId: rootReadIssuer.hostId, generationId,
    credential: { username: rootReadIssuer.username, password: rootReadIssuer.password }, ...change });
}

export async function runGitAuthenticated(arguments_: readonly string[], username: string,
  password: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  return run("/usr/bin/git", [...arguments_], { env: { ...process.env, LANG: "C", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}` } });
}

async function writeConnection(path: string, value: Readonly<Record<string, unknown>>): Promise<void> {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
