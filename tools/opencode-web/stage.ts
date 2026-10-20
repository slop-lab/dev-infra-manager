#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pin from "./upstream.json" with { type: "json" };

export async function stagePages(source: string, pagesWorktree: string) {

  const metadata: unknown = JSON.parse(await readFile(path.join(source, "build-info.json"), "utf8"));
  if (!object(metadata) || metadata.version !== pin.version || metadata.commit !== pin.commit || metadata.pagesBase !== pin.pagesBase
    || metadata.implicitServer !== false || metadata.router !== "hash") throw new Error("Rebuild the pinned Pages client before staging");
  await readFile(path.join(source, "index.html"));
  const target = path.join(pagesWorktree, "opencode-web"), versionDirectory = path.join(target, "v", pin.version);

  let versions: string[] = [];
  try {

    const previous: unknown = JSON.parse(await readFile(path.join(target, "versions.json"), "utf8"));
    if (!object(previous) || !Array.isArray(previous.versions) || !previous.versions.every((value) => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value))) throw new Error("Invalid Pages versions manifest");
    versions = previous.versions;
  } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  await mkdir(path.dirname(versionDirectory), { recursive: true });
  await rm(versionDirectory, { recursive: true, force: true });
  await cp(source, versionDirectory, { recursive: true });
  versions = [...new Set([...versions, pin.version])].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  await writeFile(path.join(target, "versions.json"), `${JSON.stringify({ default: pin.version, versions }, null, 2)}\n`);
  const redirect = `./v/${pin.version}/`;
  await writeFile(path.join(target, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${redirect}"><title>OpenCode Web</title><script>location.replace(${JSON.stringify(redirect)}+location.search+location.hash)</script></head><body><a href="${redirect}">Open OpenCode ${pin.version}</a></body></html>\n`);
  await writeFile(path.join(pagesWorktree, ".nojekyll"), "");
  return versionDirectory;
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target || process.argv.length > 4) throw new Error("usage: node tools/opencode-web/stage.ts GH_PAGES_WORKTREE [BUILD_DIRECTORY]");
  if (execFileSync("git", ["branch", "--show-current"], { cwd: target, encoding: "utf8" }).trim() !== "gh-pages") throw new Error("Target must be a gh-pages worktree");
  const source = process.argv[3] ?? fileURLToPath(new URL(`../../build/opencode-web/v/${pin.version}/`, import.meta.url));
  console.log(await stagePages(path.resolve(source), path.resolve(target)));
}
