// @ts-check
import source from "../package.json" with { type: "json" };
import { copyFile, writeFile } from "node:fs/promises";
import { minifyPackageJson } from "package.json-minifier";
import { publishPackageVersion } from "../../../scripts/publish-package-version.mjs";

const outputPath = new URL("../dist/package.json", import.meta.url);

if (source.private !== true) throw new Error("The source package.json must remain private");

const output = minifyPackageJson(source, {
  stripPackagePathPrefix: "./dist/",
  includeFields: ["exports", "types", "publishConfig"]
});
output.version = publishPackageVersion(source.version);
output.types = "./index.d.ts";
output.exports = {
  ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" },
  "./config": { types: "./bundle-config.d.ts", import: "./bundle-config.js" },
  "./service": { types: "./service.d.ts", import: "./service.js" },
  "./execution": { types: "./execution-protocol.d.ts", import: "./execution-protocol.js" },
  "./workflow": { types: "./workflowCompiler.d.ts", import: "./workflowCompiler.js" }
};
output.bin = { "dim-native-git": "cli.js" };
delete output.private;

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
