// @ts-check
/** @type {typeof import("../../../../../core/packages/managed/src/nativeGitServiceCli.js")} */
const { runNativeGitServiceCli } = await import(new URL("../../../../../core/packages/managed/dist/nativeGitServiceCli.js", import.meta.url).href);

const [stateDirectory] = process.argv.slice(2);
if (stateDirectory === undefined) throw new TypeError("native state probe fixture requires a state directory");

await runNativeGitServiceCli(
  ["check-state", "--read-only", "/var/lib/dim-native-git", "--json"],
  { stateDirectory }
);
