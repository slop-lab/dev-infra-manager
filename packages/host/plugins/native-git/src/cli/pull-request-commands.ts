import { InvalidArgumentError, type Command } from "commander";
import { UserError } from "@slop-lab/dim-host-core";
import { print, printList, type JsonFlags } from "@slop-lab/dim-host-core/controller/cli";
import { currentRevision, parsePullRequest, parsePullRequestList } from "@slop-lab/git-pull-requests";
import { invokeNativeProjectConsole } from "../projectConsole.js";
import { selectNativeProject } from "./native-project-selector.js";

type Flags = JsonFlags & { title?: string; source?: string; target?: string; body?: string; expectedVersion?: number; revision?: string; path?: string; side?: string; line?: number };
function positive(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError("must be a positive integer");
  return Number(value);
}
function ref(value: string): string { return value.startsWith("refs/") ? value : `refs/heads/${value}`; }
async function selected(projectName: string, repositoryId: string) {
  const native = await selectNativeProject();
  const project = await native.store.read(projectName, native.connection.hostId);
  const repository = project?.repositories[repositoryId];
  if (project === undefined || repository?.phase !== "ready") throw new UserError(`Project '${projectName}' has no ready repository '${repositoryId}'`);
  const scope = { projectId: project.projectId, repositoryId };
  return { scope, invoke: (operation: string, input: Readonly<Record<string, unknown>>) => invokeNativeProjectConsole(operation, { ...scope, ...input }, native.connection.nativeGit.generationId, native.environment) };
}
export function registerPullRequestCommands(project: Command): void {
  const pr = project.command("pull-request").alias("pr").description("Open and discuss revision-pinned repository pull requests");
  pr.command("list").alias("ls").argument("<project>").argument("<repository>").option("--json", "print machine-readable JSON")
    .action(async (name: string, repository: string, flags: JsonFlags) => {
      const client = await selected(name, repository);
      printList([...parsePullRequestList(await client.invoke("pull-requests.list", {}))], ["id", "title", "state", "updatedAt"], flags);
    });
  pr.command("create").argument("<project>").argument("<repository>")
    .requiredOption("--title <title>", "pull request title")
    .requiredOption("--source <proposal-ref>", "workspace proposal ref, such as proposals/WORKSPACE/change")
    .option("--target <branch>", "managed target branch; defaults to the repository's default branch")
    .option("--body <text>", "pull request description", "")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, repository: string, flags: Flags) => {
      const client = await selected(name, repository);
      print(await client.invoke("pull-requests.create", { title: flags.title, sourceRef: ref(flags.source!), body: flags.body, ...(flags.target === undefined ? {} : { targetRef: ref(flags.target) }) }), flags);
    });
  for (const operation of ["show", "refresh", "edit", "close", "reopen", "comment", "review"] as const) {
    const command = pr.command(operation).argument("<project>").argument("<repository>").argument("<id>")
      .option("--json", "print machine-readable JSON");
    if (operation !== "show") command.option("--expected-version <number>", "require a previously read PR version; otherwise read its current version", positive);
    if (operation === "edit") command.option("--title <title>", "updated title").option("--body <text>", "updated description");
    if (operation === "comment") command.requiredOption("--body <text>", "comment text")
      .option("--revision <id>", "immutable revision ID; defaults to the current revision")
      .option("--path <file>", "file for a line comment")
      .option("--side <side>", "base or head for a line comment")
      .option("--line <number>", "visible diff line", positive);
    command.action(async (name: string, repository: string, id: string, flags: Flags) => {
      if (operation === "edit" && flags.title === undefined && flags.body === undefined) throw new UserError("Use --title or --body to edit a pull request");
      const anchorOptions = [flags.path, flags.side, flags.line];
      if (operation === "comment" && anchorOptions.some((value) => value !== undefined) && anchorOptions.some((value) => value === undefined)) throw new UserError("Line comments require --path, --side and --line together");
      if (flags.side !== undefined && flags.side !== "base" && flags.side !== "head") throw new UserError("--side must be base or head");
      const client = await selected(name, repository);
      const record = parsePullRequest(await client.invoke("pull-requests.detail", { pullRequestId: id }));
      if (operation === "show") { print(record, flags); return; }
      const input = { pullRequestId: id, expectedVersion: flags.expectedVersion ?? record.version };
      if (operation === "comment") {
        print(await client.invoke("pull-requests.comment", { ...input, revisionId: flags.revision ?? currentRevision(record).id, body: flags.body,
          ...(flags.path === undefined ? {} : { anchor: { path: flags.path, side: flags.side, line: flags.line } }) }), flags);
      } else if (operation === "edit" || operation === "close" || operation === "reopen") {
        print(await client.invoke("pull-requests.update", { ...input,
          ...(flags.title === undefined ? {} : { title: flags.title }), ...(flags.body === undefined ? {} : { body: flags.body }),
          ...(operation === "close" ? { state: "closed" } : operation === "reopen" ? { state: "open" } : {}) }), flags);
      } else {
        // Preparing a review never records an approval or promotes a Git ref.
        print(await client.invoke(`pull-requests.${operation}`, input), flags);
      }
    });
  }
}
