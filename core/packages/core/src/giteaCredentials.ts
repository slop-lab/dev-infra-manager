import { randomBytes } from "node:crypto";
import { UserError } from "./errors.js";
import { giteaChangePasswordArgs } from "./giteaContainer.js";
import type { GiteaCredentials, LifecycleOptions } from "./lifecycleTypes.js";
import type { CommandResult, CommandRunner } from "./types.js";

const CREDENTIAL_PATH = "/data/dim/credentials.json";
const MISSING_CREDENTIAL_EXIT_CODE = 42;

type StoredCredentials = {
  readonly adminUsername: string;
  readonly adminPassword: string;
  readonly writerUsername: string;
  readonly writerPassword: string;
  readonly maintainerUsername: string;
  readonly maintainerPassword: string;
};

export async function ensureGiteaCredentials(
  runner: CommandRunner,
  options: LifecycleOptions,
  containerId: string
): Promise<GiteaCredentials> {
  const existing = await runner.run("docker", credentialReadArgs(containerId));
  if (existing.exitCode === 0) return parseStoredCredentials(existing.stdout);
  if (existing.exitCode !== MISSING_CREDENTIAL_EXIT_CODE) {
    assertCommand(existing, "read managed Gitea credentials");
  }

  const credentials: GiteaCredentials = {
    adminUsername: options.giteaAdminUsername,
    adminPassword: process.env.DIM_GITEA_ADMIN_PASSWORD ?? randomBytes(24).toString("base64url"),
    writerUsername: options.gitUsername,
    writerPassword: process.env.DIM_GIT_TOKEN ?? randomBytes(24).toString("base64url"),
    maintainerUsername: options.gitMaintainerUsername,
    maintainerPassword: process.env.DIM_GIT_MAINTAINER_TOKEN ?? randomBytes(24).toString("base64url")
  };
  await createUser(runner, containerId, { username: credentials.adminUsername, password: credentials.adminPassword, admin: true });
  await createUser(runner, containerId, { username: credentials.writerUsername, password: credentials.writerPassword, admin: false });
  await createUser(runner, containerId, { username: credentials.maintainerUsername, password: credentials.maintainerPassword, admin: false });
  await storeCredentials(runner, containerId, credentials);
  return credentials;
}

function credentialReadArgs(containerId: string): string[] {
  const script = `if test ! -e ${CREDENTIAL_PATH}; then exit ${MISSING_CREDENTIAL_EXIT_CODE}; fi; cat ${CREDENTIAL_PATH}`;
  return ["exec", containerId, "sh", "-c", script];
}

function parseStoredCredentials(content: string): StoredCredentials {
  const value: unknown = JSON.parse(content);
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !("adminUsername" in value) || typeof value.adminUsername !== "string" || value.adminUsername.length === 0
    || !("adminPassword" in value) || typeof value.adminPassword !== "string" || value.adminPassword.length === 0
    || !("writerUsername" in value) || typeof value.writerUsername !== "string" || value.writerUsername.length === 0
    || !("writerPassword" in value) || typeof value.writerPassword !== "string" || value.writerPassword.length === 0
    || !("maintainerUsername" in value) || typeof value.maintainerUsername !== "string" || value.maintainerUsername.length === 0
    || !("maintainerPassword" in value) || typeof value.maintainerPassword !== "string" || value.maintainerPassword.length === 0) {
    throw new UserError("Managed Gitea credentials are incomplete");
  }
  return {
    adminUsername: value.adminUsername,
    adminPassword: value.adminPassword,
    writerUsername: value.writerUsername,
    writerPassword: value.writerPassword,
    maintainerUsername: value.maintainerUsername,
    maintainerPassword: value.maintainerPassword
  };
}

async function storeCredentials(
  runner: CommandRunner,
  containerId: string,
  credentials: GiteaCredentials
): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(credentials)).toString("base64");
  const stored = await runner.run("docker", [
    "exec", "--env", `DIM_CREDENTIALS=${encoded}`, containerId,
    "sh", "-c", `umask 077; mkdir -p /data/dim; printf %s "$DIM_CREDENTIALS" | base64 -d > ${CREDENTIAL_PATH}`
  ]);
  assertCommand(stored, "store managed Gitea credentials");
}

async function createUser(
  runner: CommandRunner,
  containerId: string,
  user: { readonly username: string; readonly password: string; readonly admin: boolean }
): Promise<void> {
  const args = [
    "exec", "--user", "git", containerId,
    "gitea", "admin", "user", "create",
    "--config", "/data/gitea/conf/app.ini",
    "--username", user.username,
    "--password", user.password,
    "--email", `${user.username}@dim.invalid`,
    "--must-change-password=false"
  ];
  if (user.admin) args.push("--admin");
  const created = await runner.run("docker", args);
  if (created.exitCode === 0) return;
  if (!`${created.stdout}\n${created.stderr}`.includes("already exists")) {
    assertCommand(created, `create Gitea user ${user.username}`);
  }
  assertCommand(
    await runner.run("docker", giteaChangePasswordArgs(containerId, user.username, user.password)),
    `recover Gitea user ${user.username}`
  );
}

function assertCommand(result: CommandResult, action: string): void {
  if (result.exitCode !== 0) {
    throw new UserError(`Failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
  }
}
