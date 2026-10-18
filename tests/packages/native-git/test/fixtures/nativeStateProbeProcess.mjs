// @ts-check
import { runNativeGitServiceCli } from "../../../../../core/packages/managed/dist/nativeGitServiceCli.js";

const [stateDirectory] = process.argv.slice(2);
if (stateDirectory === undefined) throw new TypeError("native state probe fixture requires a state directory");

await runNativeGitServiceCli(
  ["check-state", "--read-only", "/var/lib/dim-native-git", "--json"],
  { stateDirectory }
);
