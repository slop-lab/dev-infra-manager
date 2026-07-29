import { copyFile, readFile, writeFile } from "node:fs/promises";
import { minifyPackageJson } from "package.json-minifier";

const sourcePath = new URL("../package.json", import.meta.url);
const outputPath = new URL("../dist/package.json", import.meta.url);
const source = JSON.parse(await readFile(sourcePath, "utf8"));
if (source.private !== true) throw new Error("The source package.json must remain private");

const output = minifyPackageJson(source, {
  stripPackagePathPrefix: "./dist/",
  includeFields: ["exports", "types", "publishConfig"]
});
output.types = "./index.d.ts";
output.exports = {
  ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" },
  "./external-url": {
    types: "./external-url.d.ts",
    import: "./external-url.js",
    default: "./external-url.js"
  }
};
output.bin = { "dim-controller-proxy": "cli.js" };
delete output.private;

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
