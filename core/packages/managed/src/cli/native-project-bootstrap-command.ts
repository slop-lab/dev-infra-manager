import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  bootstrapNativeProjectRoot,
  compileNativeRootBootstrapPolicy,
  managedStateRoot,
  UserError
} from "@slop-lab/dim-managed";
import type { Command } from "commander";
import { print, type JsonFlags } from "./cli-support.js";
import { readNativeReviewPolicyFile } from "./native-review-policy-file.js";

type NativeBootstrapFlags = JsonFlags & {
  readonly projectId: string;
  readonly sourceRepository: string;
  readonly sourceRef: string;
  readonly registrarConnection: string;
  readonly importerConnection: string;
  readonly gitExecutable: string;
  readonly reviewPolicy?: string;
};

export function registerNativeProjectBootstrapCommand(project: Command): void {
  project.command("bootstrap-native-root")
    .description("Import an exact reviewed local root into native Git")
    .argument("<project>")
    .requiredOption("--project-id <project-id>", "stable native service Project ID")
    .requiredOption("--source-repository <absolute-path>", "already-local reviewed Git repository")
    .requiredOption("--source-ref <full-branch-ref>", "canonical protected ref such as refs/heads/main")
    .requiredOption("--registrar-connection <absolute-path>", "owner-only native registrar connection")
    .requiredOption("--importer-connection <absolute-path>", "owner-only native root importer connection")
    .option("--git-executable <absolute-path>", "trusted host Git executable", "/usr/bin/git")
    .option("--review-policy <absolute-private-file>", "external reviewed policy for a manifest-free root")
    .option("--json", "print machine-readable JSON")
    .action(runNativeProjectBootstrap);
}

async function runNativeProjectBootstrap(name: string, flags: NativeBootstrapFlags): Promise<void> {
  const localPaths = [flags.sourceRepository, flags.registrarConnection,
    flags.importerConnection, flags.gitExecutable,
    ...(flags.reviewPolicy === undefined ? [] : [flags.reviewPolicy])];
  if (localPaths.some((value) => !path.isAbsolute(value))) {
    throw new UserError("native root bootstrap paths must be absolute");
  }
  const externalPolicy = flags.reviewPolicy === undefined
    ? undefined
    : await readNativeReviewPolicyFile(flags.reviewPolicy);
  if (externalPolicy !== undefined) {
    compileNativeRootBootstrapPolicy({ rootAlias: externalPolicy.rootAlias,
      protectedRef: flags.sourceRef, review: externalPolicy.review });
  }
  const stateRoot = managedStateRoot(process.env);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const draft = await bootstrapNativeProjectRoot({
    name,
    projectId: flags.projectId,
    stateRoot,
    scratchRoot: stateRoot,
    sourceRepository: flags.sourceRepository,
    selectedRef: flags.sourceRef,
    registrarConnectionFile: flags.registrarConnection,
    importerConnectionFile: flags.importerConnection,
    gitExecutable: flags.gitExecutable,
    policySource: externalPolicy === undefined
      ? { kind: "reviewed-manifest" }
      : { kind: "manifest-free", rootAlias: externalPolicy.rootAlias, review: externalPolicy.review },
    signal: AbortSignal.timeout(120_000)
  });
  print({
    name: draft.name,
    projectId: draft.projectId,
    serviceId: draft.serviceId,
    ownerHostId: draft.ownerHostId,
    generationId: draft.generationId,
    phase: draft.phase,
    rootAlias: draft.rootAlias,
    protectedRef: draft.protectedRef,
    rootCommit: draft.expectedCommit,
    rootTree: draft.expectedTree,
    policyRevision: draft.reviewPolicy.policyRevision,
    requiredReviewRevision: draft.reviewPolicy.requiredReviewRevision,
    requiredJobSetRevision: draft.reviewPolicy.requiredJobSetRevision,
    bundleDigest: draft.bundleDigest,
    bundleSize: draft.bundleSize
  }, flags);
}
