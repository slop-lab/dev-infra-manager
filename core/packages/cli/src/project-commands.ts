import { type Command } from "commander";
import {
  assertRepositorySetCanCreateProject,
  mapRepositoryRefToExternal,
  normalizeRepositoryRef,
  resolveRepositoryConnection,
  UserError,
  type RepositorySet
} from "@slop-lab/dim-core";
import {
  addRepository, adminCall, applyRepositorySet, approveRepositoryPlan, commaSeparated,
  confirmAction, createOrResumeRootProject, offerRootRepositorySet, print, printList,
  readRemoteRepositorySet, readRepositorySetFile, repositorySetPlan,
  withLocalProgress, type JsonFlags
} from "./cli-support.js";

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Manage project metadata and Git namespaces");

project.command("create")
  .description("Create a project and its managed Git namespace")
  .argument("<project>")
  .option("--repos <file>", "create and populate from a repos.yml file")
  .option("--root <alias>", "import or create the root repository with this alias")
  .option("--bootstrap-git-url <git-url>", "discover .dim/repos.yml and import its root from this Git repository")
  .option("--bootstrap-git-ref <git-ref>", "external bootstrap Git ref; defaults to the repository HEAD")
  .option("--protect <patterns>", "comma-separated protected branch patterns")
  .option("--mirror", "import every root ref instead of only branches and tags")
  .option("--apply-repos", "apply the root .dim/repos.yml without prompting")
  .option("--no-apply-repos", "do not apply the root .dim/repos.yml")
  .option("--yes", "apply the repository plan without prompting")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags & {
    repos?: string;
    root?: string;
    bootstrapGitUrl?: string;
    bootstrapGitRef?: string;
    protect?: string;
    applyRepos?: boolean;
    mirror?: boolean;
    yes?: boolean;
  }) => {
    const rootOptionsPresent = flags.root !== undefined || flags.bootstrapGitUrl !== undefined || flags.bootstrapGitRef !== undefined
      || flags.protect !== undefined
      || flags.mirror !== undefined
      || flags.applyRepos !== undefined;
    if (flags.repos !== undefined && rootOptionsPresent) {
      throw new UserError("--repos cannot be combined with root repository options");
    }
    if (flags.root === undefined && flags.bootstrapGitUrl === undefined && rootOptionsPresent) {
      throw new UserError("--root or --bootstrap-git-url is required with --bootstrap-git-ref or repository apply options");
    }
    if (flags.root === undefined && (flags.protect !== undefined || flags.mirror !== undefined)) {
      throw new UserError("--protect and --mirror require --root; manifest bootstrap reads root policy from .dim/repos.yml");
    }
    if (process.argv.includes("--apply-repos") && process.argv.includes("--no-apply-repos")) {
      throw new UserError("--apply-repos and --no-apply-repos cannot be used together");
    }
    if (flags.repos === undefined && flags.root === undefined && flags.bootstrapGitUrl === undefined) {
      print(await adminCall("project.create", { name }), flags);
      return;
    }
    if (flags.repos !== undefined) {
      const set = await readRepositorySetFile(flags.repos);
      assertRepositorySetCanCreateProject(set, flags.repos);
      const plan = await repositorySetPlan(name, set, true);
      await approveRepositoryPlan(plan, flags.yes ?? false, !flags.json);
      const repositories = await withLocalProgress("project.create", async (operation) => {
        await adminCall("project.create", { name }, operation.signal);
        operation.reportProgress("repository set apply");
        return applyRepositorySet(name, set, plan, undefined, operation);
      });
      print({ project: name, repositories }, flags);
      return;
    }

    let rootAlias = flags.root;
    let rootSet: RepositorySet | undefined;
    if (rootAlias === undefined) {
      const bootstrapGitUrl = flags.bootstrapGitUrl;
      if (bootstrapGitUrl === undefined) throw new UserError("--bootstrap-git-url is required for manifest bootstrap");
      rootSet = await withLocalProgress("project.create", (operation) => {
        operation.reportProgress("manifest discovery");
        return readRemoteRepositorySet(bootstrapGitUrl, flags.bootstrapGitRef, operation);
      });
      assertRepositorySetCanCreateProject(rootSet, `${bootstrapGitUrl}:.dim/repos.yml`);
      const root = Object.entries(rootSet.repositories).find(([, entry]) => entry.root);
      if (root === undefined) throw new UserError(`${bootstrapGitUrl}:.dim/repos.yml must contain a root repository`);
      [rootAlias] = root;
      const connection = resolveRepositoryConnection(rootSet, rootAlias);
      if (connection?.url !== flags.bootstrapGitUrl) {
        throw new UserError(
          `remote manifest root '${rootAlias}' URL '${connection?.url ?? "(empty)"}' does not match bootstrap Git URL '${flags.bootstrapGitUrl}'`
        );
      }
    }
    const rootEntry = rootSet?.repositories[rootAlias];
    const rootConnection = rootSet === undefined || rootAlias === undefined
      ? undefined
      : resolveRepositoryConnection(rootSet, rootAlias);
    const externalManifestRootRef = rootEntry?.ref === undefined
      ? undefined
      : mapRepositoryRefToExternal(rootConnection?.refNamespace, rootEntry.ref);
    if (flags.bootstrapGitRef !== undefined && externalManifestRootRef !== undefined
      && normalizeRepositoryRef(flags.bootstrapGitRef) !== normalizeRepositoryRef(externalManifestRootRef)) {
      throw new UserError(
        `--bootstrap-git-ref '${flags.bootstrapGitRef}' conflicts with manifest external root ref '${externalManifestRootRef}' for '${rootAlias}'`
      );
    }
    const selectedRootRef = rootEntry?.ref ?? flags.bootstrapGitRef;
    const repository = await withLocalProgress("project.create", async (operation) => {
      await createOrResumeRootProject(name, rootAlias, flags.bootstrapGitUrl, operation.signal);
      operation.reportProgress("root repository import");
      return addRepository(name, rootAlias, {
        ...(flags.bootstrapGitUrl === undefined ? {} : { url: flags.bootstrapGitUrl }),
        fallback: rootEntry?.fallback ?? false,
        root: true,
        ...(selectedRootRef === undefined ? {} : { ref: selectedRootRef }),
        protectedPatterns: rootEntry?.protectedPatterns
          ?? (flags.protect === undefined ? [] : commaSeparated(flags.protect)),
        forcePushBlockedPatterns: rootEntry?.forcePushBlockedPatterns ?? [],
        importBranches: rootEntry?.importBranches ?? {},
        publishBranches: rootEntry?.publishBranches ?? {},
        mirror: flags.mirror ?? false
      }, rootSet, operation);
    });
    print({ project: name, repository }, flags);
    await offerRootRepositorySet(name, flags.applyRepos);
  });

project.command("list")
  .alias("ls")
  .description("List projects")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) =>
    printList(await adminCall<Record<string, unknown>[]>("project.list"), ["name", "phase", "gitNamespace", "rootRepositoryAlias", "rootRef"], flags)
  );

project.command("show")
  .description("Show a project")
  .argument("<project>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await adminCall("project.show", { name }), flags));

project.command("remove")
  .description("Remove project metadata while preserving Git repositories")
  .argument("<project>")
  .action(async (name: string) => {
    await adminCall("project.remove", { name });
  });

project.command("purge")
  .description("Delete an unused project and its DIM-managed Git organization")
  .argument("<project>")
  .option("--yes", "confirm permanent repository deletion")
  .action(async (name: string, flags: { yes?: boolean }) => {
    await confirmAction(flags.yes ?? false, `Permanently delete project '${name}' and its managed repositories?`);
    await adminCall("project.purge", { name });
  });
}
