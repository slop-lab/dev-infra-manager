import { spawn } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd(), manifestPath = path.join(root, "package.json");
const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
if (!object(value) || typeof value.name !== "string" || !value.name.startsWith("@slop-lab/gs-")
  || value.private !== true || typeof value.version !== "string") throw new Error("expected a private GS source package");
const version = process.env.GS_BUILD_VERSION ?? value.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("invalid GS build version");
const assets = process.argv.slice(2);
if (assets.length % 2 !== 0) throw new Error("assets require --asset SOURCE:DESTINATION pairs");
const selectedAssets = [];
for (let index = 0; index < assets.length; index += 2) {
  if (assets[index] !== "--asset") throw new Error("unknown GS build argument");
  const pair = assets[index + 1]?.split(":");
  if (!pair || pair.length !== 2 || !pair.every(relativePath)) throw new Error("assets must remain within their package and artifact");
  const [source, destination] = pair;
  if (!source || !destination) throw new Error("asset paths are required");
  selectedAssets.push({ source, destination });
}
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
const compiler = createRequire(manifestPath).resolve("typescript/bin/tsc");
const child = spawn(process.execPath, [compiler, "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
if (status !== 0) throw new Error(`GS package compilation failed (${status ?? "signal"})`);
const output: Record<string, unknown> = Object.fromEntries(Object.entries(value).filter(([key]) => !["private", "scripts", "devDependencies"].includes(key)));
output.version = version;
if (object(output.publishConfig)) {
  output.publishConfig = Object.fromEntries(Object.entries(output.publishConfig).filter(([key]) => key !== "directory"));
}
for (const key of ["main", "types", "exports", "bin"]) if (output[key] !== undefined) output[key] = artifactPaths(output[key]);
for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  if (output[key] !== undefined) output[key] = dependencyVersions(output[key], version);
}
await mkdir(dist, { recursive: true });
await writeFile(path.join(dist, "package.json"), `${JSON.stringify(output, null, 2)}\n`);
await copyFile(path.join(root, "README.md"), path.join(dist, "README.md"));
await copyFile(new URL("./LICENSE", import.meta.url), path.join(dist, "LICENSE"));
for (const asset of selectedAssets) {
  const destination = path.join(dist, asset.destination);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, asset.source), destination, { recursive: true });
}
if (object(output.bin)) for (const file of Object.values(output.bin)) {
  if (typeof file !== "string" || !relativePath(file)) throw new Error("invalid GS executable artifact path");
  await chmod(path.join(dist, file), 0o755);
}

function object(input: unknown): input is Record<string, unknown> { return input !== null && typeof input === "object" && !Array.isArray(input); }
function relativePath(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && !path.isAbsolute(input)
    && !input.includes("\\") && !input.includes("\0") && !input.split("/").includes("..");
}
function artifactPaths(input: unknown): unknown {
  if (typeof input === "string") return input.replace(/^\.\/dist\//, "./");
  if (Array.isArray(input)) return input.map(artifactPaths);
  if (object(input)) return Object.fromEntries(Object.entries(input).filter(([key]) => key !== "source").map(([key, entry]) => [key, artifactPaths(entry)]));
  return input;
}
function dependencyVersions(input: unknown, version: string): Readonly<Record<string, string>> {
  if (!object(input)) throw new Error("invalid GS dependency map");
  return Object.fromEntries(Object.entries(input).map(([name, selected]) => {
    if (typeof selected !== "string") throw new Error("invalid GS dependency version");
    return [name, selected.startsWith("workspace:") ? version : selected];
  }));
}
