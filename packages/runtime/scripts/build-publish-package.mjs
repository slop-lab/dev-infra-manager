import { copyFile, readFile, writeFile } from "node:fs/promises";
import { minifyPackageJson } from "package.json-minifier";
import { publishPackageVersion } from "../../../scripts/publish-package-version.mjs";

const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (source.private !== true) throw new Error("The source package.json must remain private");
const output = minifyPackageJson(source, {
  stripPackagePathPrefix: "./dist/",
  includeFields: ["publishConfig", "exports", "types"]
});
output.version = publishPackageVersion(source.version);
output.types = "./index.d.ts";
output.exports = { ".": { types: "./index.d.ts", import: "./index.js" } };
delete output.private;
await writeFile(new URL("../dist/package.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
