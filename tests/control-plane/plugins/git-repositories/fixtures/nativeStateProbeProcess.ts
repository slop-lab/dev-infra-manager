
const { runNativeGitServiceCli }: typeof import("../../../../../packages/control-plane/deployment/src/deployment-cli.js") = await import(new URL("../../../../../packages/control-plane/deployment/dist/deployment-cli.js", import.meta.url).href);

const [stateDirectory] = process.argv.slice(2);
if (stateDirectory === undefined) throw new TypeError("native state probe fixture requires a state directory");

await runNativeGitServiceCli(
  ["check-state", "--read-only", "/var/lib/dim-native-git", "--json"],
  { stateDirectory }
);
