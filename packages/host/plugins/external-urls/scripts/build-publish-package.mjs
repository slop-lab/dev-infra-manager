// @ts-check
import source from "../package.json" with { type: "json" };
import { cp, copyFile, writeFile } from "node:fs/promises";
import { minifyPackageJson } from "package.json-minifier";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.mjs";

const outputPath = new URL("../dist/package.json", import.meta.url);

if (source.private !== true) throw new Error("The source package.json must remain private");

const output = minifyPackageJson(source, {
  stripPackagePathPrefix: "./dist",
  includeFields: ["exports", "types", "publishConfig"]
});
output.version = publishPackageVersion(source.version);
output.types = "./index.d.ts";
output.exports = { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" } };
output.dependencies = { ...source.dependencies, "@slop-lab/dim-contracts-external-url": output.version };
output.peerDependencies = { ...source.peerDependencies, "@slop-lab/dim-host-core": output.version };
delete output.private;

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));

await cp(new URL("../skills", import.meta.url), new URL("../dist/skills", import.meta.url), { recursive: true });

await cp(new URL("../src/guest", import.meta.url), new URL("../dist/guest", import.meta.url), { recursive: true });
