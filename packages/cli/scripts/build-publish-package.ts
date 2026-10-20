import source from "../package.json" with { type: "json" };
import { copyFile, writeFile } from "node:fs/promises";
import { minifyPackageJson } from "package.json-minifier";
import { publishPackageVersion } from "../../../scripts/packages/publish-package-version.ts";

const outputPath = new URL("../dist/package.json", import.meta.url);
const versionModulePath = new URL("../dist/package-version.js", import.meta.url);

if (source.private !== true) {
  throw new Error("The source package.json must remain private");
}

const output = minifyPackageJson(source, {
  stripPackagePathPrefix: "./dist",
  includeFields: ["publishConfig", "peerDependenciesMeta"]
});
output.version = publishPackageVersion(source.version);

output.dependencies = {
  ...source.dependencies,
  "@slop-lab/dim-host-core": output.version
};
output.peerDependencies = { "@slop-lab/dim-control-plane-admin": output.version, "@slop-lab/dim-host-plugin-native-git": output.version };
output.peerDependenciesMeta = { "@slop-lab/dim-control-plane-admin": { optional: true }, "@slop-lab/dim-host-plugin-native-git": { optional: true } };
output.bin = {
  dim: "cli.js"
};

if ("private" in output) {
  throw new Error("The publish package.json must not contain private");
}

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(versionModulePath, `export const packageVersion = ${JSON.stringify(output.version)};\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
