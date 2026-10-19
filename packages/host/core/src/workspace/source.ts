import { mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "../errors.js";
import { ProcessRunner } from "../runner.js";
import type { CommandResult, CommandRunner } from "../types.js";
import type { AcquiredWorkspaceSource, WorkspaceSource } from "./models.js";

export interface AcquireWorkspaceSourceInput {
  readonly source: WorkspaceSource;
  /** A new host-owned staging directory; its parent must already exist. */
  readonly destination: string;
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
}

/** Acquire an independent checkout. Only this directory is seeded into the runtime. */
export async function acquireWorkspaceSource(input: AcquireWorkspaceSourceInput): Promise<AcquiredWorkspaceSource> {
  validateSource(input.source);
  const runner = input.runner ?? new ProcessRunner();
  const destination = resolve(input.destination);
  const local = localPath(input.source.url);
  const url = local === undefined ? input.source.url : await realpath(local);
  const acquisitionEnvironment = gitEnvironment(false);
  const checkoutEnvironment = gitEnvironment(true);
  const git = async (args: string[], checkout = false): Promise<CommandResult> => {
    input.signal?.throwIfAborted();
    return runner.run("git", ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=",
      "-c", "protocol.ext.allow=never", ...args], {
      env: checkout ? checkoutEnvironment : acquisitionEnvironment,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  };
  // Creating the directory ourselves prevents both overwriting an existing checkout
  // and deleting caller-owned files if Git acquisition fails.
  await mkdir(destination, { mode: 0o700 });
  try {
    checked(await git(["clone", "--no-checkout", "--no-local", "--no-hardlinks", "--", url, destination]), "clone source");
    const at = ["-C", destination];
    const requested = input.source.ref ?? "HEAD";
    const head = await git([...at, "symbolic-ref", "--quiet", "HEAD"], true);
    let ref = head.exitCode === 0 && requested === "HEAD" ? head.stdout.trim() : requested;
    let revision = "HEAD";
    if (requested !== "HEAD") {
      checked(await git([...at, "fetch", "--no-tags", "--", "origin", requested]), "fetch source ref");
      revision = "FETCH_HEAD";
      const branch = requested.startsWith("refs/heads/") ? requested.slice("refs/heads/".length) : requested;
      const remoteBranch = await git([...at, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], true);
      if (remoteBranch.exitCode === 0) ref = `refs/heads/${branch}`;
      else if (!requested.startsWith("refs/") && (await git([...at, "show-ref", "--verify", "--quiet", `refs/tags/${requested}`], true)).exitCode === 0) {
        ref = `refs/tags/${requested}`;
      }
    }
    const commit = checked(await git([...at, "rev-parse", "--verify", `${revision}^{commit}`], true), "resolve source commit").stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new UserError("Git returned an invalid source commit");
    const checkout = ref.startsWith("refs/heads/")
      ? ["checkout", "--force", "-B", ref.slice("refs/heads/".length), commit]
      : ["checkout", "--force", "--detach", commit];
    checked(await git([...at, "-c", "core.sparseCheckout=false", ...checkout], true), "check out source");
    if (local !== undefined) {
      const upstream = await git(["-C", url, "remote", "get-url", "origin"]);
      const origin = upstream.exitCode === 0 ? upstream.stdout.trim() : "";
      if (isPortableRemote(origin)) checked(await git([...at, "remote", "set-url", "origin", origin], true), "set workspace origin");
      else checked(await git([...at, "remote", "remove", "origin"], true), "remove host-only origin");
    }
    return { url, ref, commit };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function checked(result: CommandResult, action: string): CommandResult {
  if (result.exitCode !== 0) throw new UserError(`Failed to ${action}: ${result.stderr.trim() || "Git command failed"}`);
  return result;
}

function validateSource(source: WorkspaceSource): void {
  if (typeof source.url !== "string" || source.url.length === 0 || /[\x00-\x1f\x7f]/.test(source.url)
    || source.url.startsWith("-")) throw new UserError("Source must be a local Git path or an HTTP(S)/SSH Git URL");
  if (localPath(source.url) === undefined && !isPortableRemote(source.url)) {
    throw new UserError("Source must use HTTP(S) or SSH without embedded passwords, tokens, query parameters, or fragments");
  }
  if (source.ref !== undefined && (source.ref.length === 0 || source.ref.length > 1024
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(source.ref) || source.ref.includes("..")
    || source.ref.includes("//") || source.ref.endsWith("/") || source.ref.endsWith(".")
    || source.ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")))) {
    throw new UserError("Source ref must be a Git branch, tag, or commit ID");
  }
}

function localPath(url: string): string | undefined {
  if (url.startsWith("file:")) {
    try { return fileURLToPath(url); }
    catch { throw new UserError("Source file URL is invalid"); }
  }
  if (isAbsolute(url) || url.startsWith("./") || url.startsWith("../") || !url.includes(":")) return resolve(url);
  return undefined;
}

function isPortableRemote(value: string): boolean {
  if (/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:[^:\s\x00-\x1f\x7f][^\s\x00-\x1f\x7f]*$/.test(value) && !value.includes("://")) return true;
  try {
    const url = new URL(value);
    return ["https:", "http:", "ssh:"].includes(url.protocol) && url.hostname !== ""
      && url.password === "" && (url.protocol === "ssh:" || url.username === "")
      && url.search === "" && url.hash === "";
  } catch { return false; }
}

function gitEnvironment(checkout: boolean): NodeJS.ProcessEnv {
  // Acquisition may use the operator's host-side credential helper or SSH agent.
  // Repository context from the calling shell must never redirect these commands.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  environment.GIT_TERMINAL_PROMPT = "0";
  for (const key of ["GIT_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND"]) {
    if (!checkout && process.env[key] !== undefined) environment[key] = process.env[key];
  }
  if (checkout) {
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_CONFIG_GLOBAL = "/dev/null";
    environment.GIT_ATTR_NOSYSTEM = "1";
  }
  return environment;
}
