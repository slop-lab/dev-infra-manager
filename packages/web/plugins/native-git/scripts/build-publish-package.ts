import { build } from "esbuild";
import { cp, copyFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.ts";
import source from "../package.json" with { type: "json" };
const version = publishPackageVersion(source.version);
const dependencies = Object.fromEntries(Object.entries(source.dependencies).map(([name, value]) => [name, value.startsWith("workspace:") ? version : value]));
await writeFile(new URL("../dist/package.json", import.meta.url), JSON.stringify({ name: source.name, version, type: "module", license: "MIT", main: "./index.js", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" } }, dependencies, peerDependencies: { "@slop-lab/dim-web": version }, engines: source.engines }, null, 2) + "\n");
await cp(new URL("../src/assets", import.meta.url), new URL("../dist/assets", import.meta.url), { recursive: true });
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));

await build({ entryPoints: {
  "pull-requests": new URL("../src/pull-requests.ts", import.meta.url).pathname,
  "pr-model": new URL(import.meta.resolve("@slop-lab/git-pull-requests")).pathname
}, outdir: new URL("../dist/assets/", import.meta.url).pathname,
  splitting: true, chunkNames: "pr-model-shared",
  bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true,
  define: { "process.env.NODE_ENV": '"production"' }, legalComments: "eof" });
await build({ entryPoints: [new URL("../src/review-detail.ts", import.meta.url).pathname], outfile: new URL("../dist/assets/review-detail.js", import.meta.url).pathname,
  bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "eof" });

for (const [source, target] of [["@slop-lab/react-git-diff/styles.css", "git-diff.css"], ["@slop-lab/react-git-pull-requests/styles.css", "pull-requests.css"]] as const) {
  await copyFile(new URL(import.meta.resolve(source)), new URL(`../dist/assets/${target}`, import.meta.url));
}
