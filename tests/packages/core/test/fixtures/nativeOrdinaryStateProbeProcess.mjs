import { runNativeOrdinaryServiceCli } from "../../../../../core/packages/core/dist/nativeOrdinaryServiceCli.js";

const [stateDirectory] = process.argv.slice(2);
if (stateDirectory === undefined) throw new TypeError("state probe fixture requires a state directory");

await runNativeOrdinaryServiceCli(
  ["check-state", "--read-only", "/var/lib/dim-ordinary-ci", "--json"],
  { stateDirectory }
);
