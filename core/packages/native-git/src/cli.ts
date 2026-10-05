#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import {
  createConfiguredNativeGitServer,
  createNodeAdmissionVerifierHttpClient,
  parseNativeGitServiceConfig
} from "./index.js";
import { requestReviewApi, type ReviewClientCredentials } from "./review-client.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "serve" && args.length === 2) {
    await serve(args[1]);
    return;
  }
  if (args[0] === "review") {
    await review(args.slice(1));
    return;
  }
  usage();
}

async function serve(configPath: string | undefined): Promise<void> {
  if (configPath === undefined) return usage();
  const stat = await lstat(configPath);
  const uid = process.getuid?.();
  if (uid === undefined || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new NativeGitConfigFileError("native Git configuration must be a caller-owned mode-0600 regular file");
  }
  const config = parseNativeGitServiceConfig(JSON.parse(await readFile(configPath, "utf8")));
  const service = await createConfiguredNativeGitServer(config, createNodeAdmissionVerifierHttpClient());
  const baseUrl = await service.listen();
  process.stdout.write(`${baseUrl}\n`);
  const stop = async (): Promise<void> => {
    await service.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

async function review(args: readonly string[]): Promise<void> {
  const baseUrl = args[0];
  const operation = args[1];
  const projectId = args[2];
  const repositoryId = args[3];
  if (baseUrl === undefined || operation === undefined || projectId === undefined || repositoryId === undefined) return usage();
  const prefix = `/v1/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}/reviews`;
  const credentials = reviewCredentials();
  let request: Parameters<typeof requestReviewApi>[0];
  if (operation === "inspect" && args.length === 6) {
    request = {
      baseUrl,
      method: "POST",
      path: prefix,
      credentials,
      body: { protectedRef: args[4], proposalRef: args[5] }
    };
  } else if (operation === "show" && args.length === 5) {
    request = { baseUrl, method: "GET", path: `${prefix}/${args[4]}`, credentials };
  } else if (operation === "approve" && args.length === 5) {
    request = { baseUrl, method: "POST", path: `${prefix}/${args[4]}/approvals`, credentials, body: {} };
  } else if (operation === "revoke" && args.length === 6) {
    request = {
      baseUrl,
      method: "POST",
      path: `${prefix}/${args[4]}/revocations`,
      credentials,
      body: { approvalId: args[5] }
    };
  } else {
    return usage();
  }
  process.stdout.write(await requestReviewApi(request));
}

function reviewCredentials(): ReviewClientCredentials {
  const username = process.env.DIM_NATIVE_GIT_USERNAME;
  const password = process.env.DIM_NATIVE_GIT_PASSWORD;
  if (username === undefined || password === undefined) {
    throw new NativeGitConfigFileError("DIM_NATIVE_GIT_USERNAME and DIM_NATIVE_GIT_PASSWORD are required for review commands");
  }
  return { username, password };
}

function usage(): void {
  process.stderr.write([
    "usage: dim-native-git serve /absolute/path/to/config.json",
    "       dim-native-git review API_ORIGIN inspect PROJECT REPOSITORY PROTECTED_REF PROPOSAL_REF",
    "       dim-native-git review API_ORIGIN show PROJECT REPOSITORY REVIEW_ID",
    "       dim-native-git review API_ORIGIN approve PROJECT REPOSITORY REVIEW_ID",
    "       dim-native-git review API_ORIGIN revoke PROJECT REPOSITORY REVIEW_ID APPROVAL_ID"
  ].join("\n") + "\n");
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

class NativeGitConfigFileError extends Error {
  readonly name = "NativeGitConfigFileError";
}
