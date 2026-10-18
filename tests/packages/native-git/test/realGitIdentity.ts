import { execFileSync } from "node:child_process";

/** Pin integration fixtures to the binary they actually execute, once per test worker. */
export const realGitExecutable = "/usr/bin/git";
const output = execFileSync(realGitExecutable, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const match = /^git version ([0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9._-]*)?)$/.exec(output);
if (match === null) throw new Error(`Unexpected Git version output from ${realGitExecutable}`);
export const realGitVersion = match[1]!;
