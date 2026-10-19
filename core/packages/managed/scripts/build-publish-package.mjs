// @ts-check
import source from "../package.json" with { type: "json" };
import { cp, copyFile, writeFile } from "node:fs/promises";
import { minifyPackageJson } from "package.json-minifier";
import { publishPackageVersion } from "../../../scripts/publish-package-version.mjs";

const outputPath = new URL("../dist/package.json", import.meta.url);
const versionModulePath = new URL("../dist/package-version.js", import.meta.url);

if (source.private !== true) {
  throw new Error("The source package.json must remain private");
}

const output = minifyPackageJson(source, {
  stripPackagePathPrefix: "./dist/",
  includeFields: ["publishConfig", "exports", "types"]
});
output.version = publishPackageVersion(source.version);
output.dependencies = {
  ...source.dependencies,
  "@slop-lab/dim-core": output.version,
  "@slop-lab/dim-control-plane": output.version,
  "@slop-lab/dim-plugin-control-plane-native-git": output.version,
  "@slop-lab/dim-plugin-control-plane-ci-workflows": output.version
};

output.types = "./index.d.ts";
output.exports = {
  ".": {
    types: "./index.d.ts",
    import: "./index.js"
  },
  "./ci": { types: "./ci/operations.d.ts", import: "./ci/operations.js" },
  "./host": { types: "./nativeWorkspaceHost.d.ts", import: "./nativeWorkspaceHost.js" },
  "./cli": { types: "./cli/managed-cli.d.ts", import: "./cli/managed-cli.js" }
};
output.bin = { "dim-service": "nativeOrdinaryServiceCli.js" };

if ("private" in output) {
  throw new Error("The publish package.json must not contain private");
}

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(versionModulePath, `export const packageVersion = ${JSON.stringify(output.version)};\n`);
await writeFile(new URL("../dist/cli/package-version.js", import.meta.url), `export const packageVersion = ${JSON.stringify(output.version)};\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
await cp(
  new URL("../src/native-qemu-runner-assets", import.meta.url),
  new URL("../dist/native-qemu-runner-assets", import.meta.url),
  { recursive: true }
);

await cp(new URL("../docs", import.meta.url), new URL("../dist/docs", import.meta.url), { recursive: true });
