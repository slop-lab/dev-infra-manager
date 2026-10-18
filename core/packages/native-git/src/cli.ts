#!/usr/bin/env node
import { runNativeGitOperatorReview } from "./operator-review-cli.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "operator" && args[1] === "review" && await runNativeGitOperatorReview(args.slice(2))) return;
  process.stderr.write([
    "usage: dim-native-git operator review resolve CONNECTION PROJECT PROPOSAL_REF",
    "       dim-native-git operator review inspect CONNECTION PROJECT REVIEW_ID",
    "       dim-native-git operator review approve CONNECTION PROJECT REVIEW_ID",
    "       dim-native-git operator review revoke CONNECTION PROJECT REVIEW_ID APPROVAL_ID",
    "       dim-native-git operator review promote CONNECTION PROJECT REVIEW_ID"
  ].join("\n") + "\n");
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
