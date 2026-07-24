import { readFile, writeFile } from "node:fs/promises";
import { minifyPackageJson } from "package.json-minifier";

const sourcePath = new URL("../package.json", import.meta.url);
const outputPath = new URL("../dist/package.json", import.meta.url);
const source = JSON.parse(await readFile(sourcePath, "utf8"));

if (source.private !== true) {
  throw new Error("The source package.json must remain private");
}

const output = minifyPackageJson(source, {
  stripPackagePathPrefix: "./dist/",
  includeFields: ["publishConfig", "exports", "types"]
});

output.types = "./index.d.ts";
output.exports = {
  ".": {
    types: "./index.d.ts",
    import: "./index.js"
  }
};

if ("private" in output) {
  throw new Error("The publish package.json must not contain private");
}

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);

