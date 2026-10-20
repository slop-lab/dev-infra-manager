#!/usr/bin/env node
import { runNativeGitOperatorReview } from "./operator-review-cli.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (await runNativeGitOperatorReview(args)) return;
  process.stderr.write([
    "usage: dim-code-review resolve CONNECTION PROJECT REPOSITORY PROPOSAL_REF",
    "       dim-code-review inspect CONNECTION PROJECT REPOSITORY REVIEW_ID",
    "       dim-code-review approve CONNECTION PROJECT REPOSITORY REVIEW_ID",
    "       dim-code-review revoke CONNECTION PROJECT REPOSITORY REVIEW_ID APPROVAL_ID"
  ].join("\n") + "\n");
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
