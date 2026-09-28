import { type Command } from "commander";
import { buildSharedGitSyncImage, ProcessRunner, UserError } from "@slop-lab/dim-core";
import {
  addRepository, adminCall, approveRepositoryPlan, applyRepositorySet, commaSeparated,
  confirmAction, fetchRepository, offerRootRepositorySet, print, printList,
  publishRepositories, repositorySetPlan, resolveRepositorySet,
  type JsonFlags, type RepoFlags
} from "./cli-support.js";

export function registerRepositoryCommands(program: Command): void {
  const repo = program.command("repo").description("Manage project-scoped repositories");
  const syncServiceImage = repo.command("sync-service").description("Manage shared Git-host sync deployment assets")
    .command("image").description("Manage the shared Git-host sync service image");
  syncServiceImage.command("build")
    .description("Build the separately deployed shared Git-host sync service image")
    .argument("<image>", "explicit non-latest image tag")
    .action(async (image: string) => {
      await buildSharedGitSyncImage(new ProcessRunner(), image);
      console.log(image);
    });

repo.command("add")
  .description("Add an empty repository or import an external Git URL")
  .argument("<project>")
  .argument("<alias>")
  .argument("[url]")
  .option("--root", "make this the project root repository")
  .option("--ref <branch-or-ref>", "root branch/ref; defaults to the repository HEAD")
  .option("--protect <patterns>", "comma-separated protected branch patterns")
  .option("--mirror", "import every ref instead of only branches and tags")
  .option("--apply-repos", "apply .dim/repos.yml after adding the root")
  .option("--no-apply-repos", "do not apply .dim/repos.yml after adding the root")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, alias: string, url: string | undefined, flags: RepoFlags & { applyRepos?: boolean; mirror?: boolean }) => {
    if (process.argv.includes("--apply-repos") && process.argv.includes("--no-apply-repos")) {
      throw new UserError("--apply-repos and --no-apply-repos cannot be used together");
    }
    if (!flags.root && flags.applyRepos !== undefined) {
      throw new UserError("repository apply options require --root");
    }
    const repository = await addRepository(projectName, alias, {
      ...(url === undefined ? {} : { url }),
      fallback: false,
      root: flags.root ?? false,
      ...(flags.ref === undefined ? {} : { ref: flags.ref }),
      protectedPatterns: flags.protect === undefined ? [] : commaSeparated(flags.protect),
      forcePushBlockedPatterns: [],
      importBranches: {},
      publishBranches: {},
      mirror: flags.mirror ?? false
    });
    print(repository, flags);
    if (flags.root) await offerRootRepositorySet(projectName, flags.applyRepos);
  });

repo.command("plan")
  .description("Preview repositories from repos.yml without changing state")
  .argument("<project>")
  .option("--file <file>", "read an explicit repos.yml instead of the managed root")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, flags: JsonFlags & { file?: string }) => {
    const set = await resolveRepositorySet(projectName, flags.file);
    print(await repositorySetPlan(projectName, set, false), flags);
  });

repo.command("apply")
  .description("Reconcile repositories from repos.yml")
  .argument("<project>")
  .option("--file <file>", "read an explicit repos.yml instead of the managed root")
  .option("--rebind-origin <alias>", "rebind only the existing ready root origin")
  .option("--expect-origin-tip <full-sha>", "require this exact 40-character lowercase origin tip")
  .option("--yes", "apply without prompting")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, flags: JsonFlags & {
    file?: string;
    yes?: boolean;
    rebindOrigin?: string;
    expectOriginTip?: string;
  }) => {
    const requestedRebind = flags.rebindOrigin !== undefined || flags.expectOriginTip !== undefined;
    if (requestedRebind && (flags.rebindOrigin === undefined || flags.expectOriginTip === undefined || flags.yes !== true)) {
      throw new UserError("--rebind-origin, --expect-origin-tip, and --yes are required together");
    }
    if (flags.expectOriginTip !== undefined && !/^[0-9a-f]{40}$/.test(flags.expectOriginTip)) {
      throw new UserError("--expect-origin-tip must be exactly 40 lowercase hexadecimal characters");
    }
    const set = await resolveRepositorySet(projectName, flags.file);
    const plan = await repositorySetPlan(projectName, set, false, flags.rebindOrigin);
    await approveRepositoryPlan(plan, flags.yes ?? false, !flags.json);
    if (requestedRebind && plan.actions.some(({ action }) => action !== "unchanged" && action !== "rebind")) {
      throw new UserError("root origin rebind cannot be combined with other repository changes");
    }
    print(await applyRepositorySet(
      projectName,
      set,
      plan,
      flags.rebindOrigin === undefined || flags.expectOriginTip === undefined
        ? undefined
        : { alias: flags.rebindOrigin, expectedOriginTip: flags.expectOriginTip }
    ), flags);
  });

repo.command("list")
  .alias("ls")
  .description("List repositories in a project")
  .argument("<project>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) =>
    printList(await adminCall<Record<string, unknown>[]>("repo.list", { project: name }), ["alias", "phase", "ref", "hostUrl", "workspaceUrl"], flags)
  );

repo.command("show")
  .description("Show a project repository")
  .argument("<project>")
  .argument("<alias>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, alias: string, flags: JsonFlags) =>
    print(await adminCall("repo.show", { project: name, alias }), flags)
  );

repo.command("delete")
  .description("Delete an unused non-root repository from DIM and managed Gitea")
  .argument("<project>")
  .argument("<alias>")
  .option("--yes", "confirm permanent repository deletion")
  .action(async (project: string, alias: string, flags: { yes?: boolean }) => {
    await confirmAction(flags.yes ?? false, `Permanently delete repository '${project}/${alias}'?`);
    await adminCall("repo.delete", { project, alias });
  });

repo.command("protect")
  .description("Apply configured branch protection after the initial push")
  .argument("<project>")
  .argument("<alias>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, alias: string, flags: JsonFlags) =>
    print(await adminCall("repo.protect", { project: name, alias }), flags)
  );

repo.command("fetch")
  .description("Fetch external branches into upstream/* and import tags")
  .argument("<project>")
  .argument("<alias>")
  .option("--prune", "delete upstream/* branches removed from the external repository")
  .action(async (projectName: string, alias: string, flags: { prune?: boolean }) => {
    await fetchRepository(projectName, alias, flags.prune ?? false);
  });

repo.command("publish")
  .description("Publish configured branches for one repository or the whole project")
  .argument("<project>")
  .argument("[alias]")
  .action(async (projectName: string, alias?: string) => {
    const published = await publishRepositories(projectName, alias);
    for (const item of published) console.log(item);
  });

repo.command("url")
  .description("Print a repository URL")
  .argument("<project>")
  .argument("<alias>")
  .option("--workspace", "print the URL reachable from workspaces")
  .action(async (name: string, alias: string, flags: { workspace?: boolean }) =>
    console.log((await adminCall<{ url: string }>("repo.url", {
      project: name,
      alias,
      workspace: flags.workspace ?? false
    })).url));
}
