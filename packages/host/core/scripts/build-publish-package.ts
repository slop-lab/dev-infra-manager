import source from "../package.json" with { type: "json" };
import { cp, copyFile, writeFile } from "node:fs/promises";
import { minifyPackageJson } from "package.json-minifier";
import { publishPackageVersion } from "../../../../scripts/packages/publish-package-version.ts";

const outputPath = new URL("../dist/package.json", import.meta.url);
const versionModulePath = new URL("../dist/package-version.js", import.meta.url);

if (source.private !== true) {
  throw new Error("The source package.json must remain private");
}

const output = minifyPackageJson(source, {
  stripPackagePathPrefix: "./dist",
  includeFields: ["publishConfig", "exports", "types"]
});
output.version = publishPackageVersion(source.version);

output.types = "./index.d.ts";
output.exports = {
  ".": {
    types: "./index.d.ts",
    import: "./index.js"
  },
  "./workspace": { types: "./workspace.d.ts", import: "./workspace.js" },
  "./controller": { types: "./controller/index.d.ts", import: "./controller/index.js", default: "./controller/index.js" },
  "./controller/cli": { types: "./controller/cli/index.d.ts", import: "./controller/cli/index.js", default: "./controller/cli/index.js" }
};

if ("private" in output) {
  throw new Error("The publish package.json must not contain private");
}

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(versionModulePath, `export const packageVersion = ${JSON.stringify(output.version)};\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
await cp(
  new URL("../src/workspace-image-assets", import.meta.url),
  new URL("../dist/workspace-image-assets", import.meta.url),
  { recursive: true }
);
