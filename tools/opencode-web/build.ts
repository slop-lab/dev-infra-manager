#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pin from "./upstream.json" with { type: "json" };
import { patchPages } from "./patch.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const source = path.resolve(process.argv[2] ?? path.join(homedir(), ".cache/dim/opencode-web", pin.commit));
const output = path.resolve(process.argv[3] ?? path.join(repository, "build/opencode-web/v", pin.version));
if (output === source || source.startsWith(output + path.sep) || repository === output || repository.startsWith(output + path.sep) || output === homedir()) throw new Error("Output must be a separate generated artifact directory");

function run(file: string, args: string[], cwd: string = source) { return execFileSync(file, args, { cwd, stdio: "inherit", env: { ...process.env, HUSKY: "0", OPENCODE_CHANNEL: "latest" } }); }
if (execFileSync("bun", ["--version"], { encoding: "utf8" }).trim() !== pin.bun) throw new Error(`Use Bun ${pin.bun}`);
if (!await access(source).then(() => true, () => false)) {
  await mkdir(path.dirname(source), { recursive: true });
  run("git", ["clone", "--depth", "1", "--branch", `v${pin.version}`, pin.repository, source], path.dirname(source));
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
if (commit !== pin.commit) throw new Error("OpenCode source does not match the reviewed commit");
run("git", ["diff", "--exit-code", "--", "packages/app/src/entry.tsx", "packages/app/src/app.tsx"]);
run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"]);
const appDirectory = path.join(source, "packages/app");
const entryFile = path.join(appDirectory, "src/entry.tsx"), appFile = path.join(appDirectory, "src/app.tsx");
const entry = await readFile(entryFile, "utf8"), app = await readFile(appFile, "utf8");
const patched = patchPages(entry, app);
try {
  await writeFile(entryFile, patched.entry); await writeFile(appFile, patched.app);
  run("bun", ["run", "build", `--base=${pin.pagesBase}`], appDirectory);
} finally { await writeFile(entryFile, entry); await writeFile(appFile, app); }
await rm(output, { recursive: true, force: true });
await cp(path.join(appDirectory, "dist"), output, { recursive: true, filter: (file) => !file.endsWith(".map") });
const indexFile = path.join(output, "index.html");
await writeFile(indexFile, (await readFile(indexFile, "utf8")).replaceAll('content="/', `content="${pin.pagesBase}`));
const manifestFile = path.join(output, "site.webmanifest");

const manifest: unknown = JSON.parse(await readFile(manifestFile, "utf8"));
if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) throw new Error("Invalid upstream web manifest");
const icons = "icons" in manifest && Array.isArray(manifest.icons) ? manifest.icons : [];
for (const icon of icons) if (typeof icon === "object" && icon !== null && "src" in icon && typeof icon.src === "string" && icon.src.startsWith("/")) icon.src = pin.pagesBase + icon.src.slice(1);
await writeFile(manifestFile, `${JSON.stringify({ ...manifest, id: pin.pagesBase, scope: pin.pagesBase, start_url: pin.pagesBase }, null, 2)}\n`);
await cp(path.join(source, "LICENSE"), path.join(output, "OPENCODE-LICENSE.txt"));
await cp(new URL("./REFERENCE-LICENSE.txt", import.meta.url), path.join(output, "PAGES-ADAPTER-LICENSE.txt"));
await writeFile(path.join(output, "build-info.json"), `${JSON.stringify({ ...pin, router: "hash", implicitServer: false }, null, 2)}\n`);
console.log(`Built OpenCode ${pin.version} at ${output}`);
