import { copyFile, readFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "./publish-package-version.mjs";

const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (source.private !== true) throw new Error("The host mirror provider source package must remain private");
delete source.private;
source.version = publishPackageVersion(source.version);
source.peerDependencies["@slop-lab/dim-core"] = source.version;
source.types = "./index.d.ts";
source.main = "./index.js";
source.exports = { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" } };
delete source.scripts;
delete source.devDependencies;
await writeFile(new URL("../dist/package.json", import.meta.url), `${JSON.stringify(source, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
