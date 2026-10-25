import { InvalidArgumentError, type Command } from "commander";
import { print, printList, type JsonFlags } from "@slop-lab/dim-host-core/controller/cli";
import { selectNativeRepository } from "./native-project-selector.js";

export function registerRepositoryOperationCommands(project: Command): void {
  project.command("diff").description("Inspect an immutable comparison in the selected repository")
    .argument("<project>").argument("<repository>")
    .requiredOption("--base <commit>", "complete base commit ID").requiredOption("--head <commit>", "complete candidate commit ID")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, repositoryId: string, flags: JsonFlags & { base: string; head: string }) => {
      const selected = await selectNativeRepository(name, repositoryId);
      print(await selected.invoke("diff.read", { baseCommit: flags.base, headCommit: flags.head }), flags);
    });
  project.command("blame").description("Read the original author of an exact committed line")
    .argument("<project>").argument("<repository>")
    .requiredOption("--commit <commit>", "complete immutable commit ID").requiredOption("--path <path>", "repository-relative text file")
    .requiredOption("--line <line>", "positive line number", (value: string) => {
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError("line must be a positive integer");
      return Number(value);
    }).option("--json", "print machine-readable JSON")
    .action(async (name: string, repositoryId: string, flags: JsonFlags & { commit: string; path: string; line: number }) => {
      const selected = await selectNativeRepository(name, repositoryId);
      print(await selected.invoke("blame.line", { commit: flags.commit, path: flags.path, line: flags.line }), flags);
    });
  const review = project.command("review").description("Inspect exact reviews and DIM CI separately from human decisions");
  review.command("list").argument("<project>").argument("<repository>").option("--json", "print machine-readable JSON")
    .action(async (name: string, repositoryId: string, flags: JsonFlags) => {
      const selected = await selectNativeRepository(name, repositoryId);
      const rows = await selected.invoke("reviews.list", {});
      if (!Array.isArray(rows)) throw new InvalidArgumentError("review list is unavailable");
      printList(rows, ["reviewId", "proposalRef", "protectedRef", "status"], flags);
    });
  review.command("resolve").argument("<project>").argument("<repository>")
    .requiredOption("--source <ref>", "source branch or refs/tags/TAG").option("--target <ref>", "managed target branch")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, repositoryId: string, flags: JsonFlags & { source: string; target?: string }) => {
      const selected = await selectNativeRepository(name, repositoryId);
      const ref = (value: string) => value.startsWith("refs/") ? value : `refs/heads/${value}`;
      print(await selected.invoke("reviews.resolve", { proposalRef: ref(flags.source), ...(flags.target === undefined ? {} : { protectedRef: ref(flags.target) }) }), flags);
    });
  for (const action of ["inspect", "approve", "revoke", "promote"] as const) {
    const command = review.command(action).argument("<project>").argument("<repository>").argument("<review-id>")
      .option("--json", "print machine-readable JSON");
    if (action === "revoke") command.requiredOption("--approval <id>", "this reviewer's approval ID");
    command.action(async (name: string, repositoryId: string, reviewId: string, flags: JsonFlags & { approval?: string }) => {
      const selected = await selectNativeRepository(name, repositoryId);
      print(await selected.invoke(action === "inspect" ? "reviews.detail" : `reviews.${action}`,
        { reviewId, ...(flags.approval === undefined ? {} : { approvalId: flags.approval }) }), flags);
    });
  }
}

export function registerRepositoryMergeCommand(repository: Command): void {
  repository.command("merge").description("Prepare a managed branch merge through the review and DIM CI path")
    .argument("<project>").argument("<repository>")
    .requiredOption("--source <branch>", "managed source branch")
    .requiredOption("--target <branch>", "managed protected target branch")
    .option("--json", "print machine-readable JSON")
    .action(async (name: string, repositoryId: string, flags: JsonFlags & { source: string; target: string }) => {
      const selected = await selectNativeRepository(name, repositoryId);
      const ref = (value: string) => value.startsWith("refs/") ? value : `refs/heads/${value}`;
      print(await selected.invoke("merges.prepare", { sourceRef: ref(flags.source), targetRef: ref(flags.target) }), flags);
    });
}
