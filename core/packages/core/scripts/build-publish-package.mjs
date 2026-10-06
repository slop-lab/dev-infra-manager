import { cp, copyFile, readFile, writeFile } from "node:fs/promises";
import { minifyPackageJson } from "package.json-minifier";
import { publishPackageVersion } from "../../../scripts/publish-package-version.mjs";

const sourcePath = new URL("../package.json", import.meta.url);
const outputPath = new URL("../dist/package.json", import.meta.url);
const versionModulePath = new URL("../dist/package-version.js", import.meta.url);
const source = JSON.parse(await readFile(sourcePath, "utf8"));

if (source.private !== true) {
  throw new Error("The source package.json must remain private");
}

const output = minifyPackageJson(source, {
  stripPackagePathPrefix: "./dist/",
  includeFields: ["publishConfig", "exports", "types"]
});
output.version = publishPackageVersion(source.version);
output.dependencies = {
  ...output.dependencies,
  "@slop-lab/dim-controller-proxy": output.version
};

output.types = "./index.d.ts";
output.exports = {
  ".": {
    types: "./index.d.ts",
    import: "./index.js"
  }
};
output.bin = { "dim-service": "nativeOrdinaryServiceCli.js" };

if ("private" in output) {
  throw new Error("The publish package.json must not contain private");
}

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(versionModulePath, `export const packageVersion = ${JSON.stringify(output.version)};\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
await cp(
  new URL("../src/workspace-image-assets", import.meta.url),
  new URL("../dist/workspace-image-assets", import.meta.url),
  { recursive: true }
);
await cp(
  new URL("../src/shared-qemu-scheduler-assets", import.meta.url),
  new URL("../dist/shared-qemu-scheduler-assets", import.meta.url),
  { recursive: true }
);
await cp(
  new URL("../src/shared-git-sync-assets", import.meta.url),
  new URL("../dist/shared-git-sync-assets", import.meta.url),
  { recursive: true }
);
