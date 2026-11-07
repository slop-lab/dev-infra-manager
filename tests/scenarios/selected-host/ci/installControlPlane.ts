import { readExampleArtifacts } from "../../../../scripts/examples/bundle.ts";
import { runCommand } from "../../web-lifecycle/process.ts";

const facade = process.env.DIM_EXAMPLE_DIM_BIN, bundle = process.env.DIM_EXAMPLE_PACKAGE_BUNDLE;
if (!facade || !bundle) throw new Error("practical CP preparation requires its installed facade and reviewed bundle");
const artifacts = await readExampleArtifacts(bundle), version = artifacts.find(({ name }) => name === "@slop-lab/dim-cli")?.version;
if (!version) throw new Error("fixture bundle has no CLI version");
await runCommand(facade, ["installer", "install", "control-plane", "plugin", "--local-packages", bundle,
  `@slop-lab/dim-control-plane-plugin-llm-router@${version}`, `@slop-lab/dim-control-plane-plugin-external-urls@${version}`]);
