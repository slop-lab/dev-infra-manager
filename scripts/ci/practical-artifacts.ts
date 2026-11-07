import { lstat, realpath, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const credentialKey = /^(?:password|token|authorization|credential|credentials|secret|privateKey|private_key|cookie)$/i;
export function redactPracticalLog(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "[REDACTED AUTHORIZATION]")
    .replace(/(["']?(?:password|token|authorization|secret|private_key|cookie)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,}]+)/gi, "$1[REDACTED]");
}
function safeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, credentialKey.test(key) ? "[REDACTED]" : safeJson(entry)]));
  return typeof value === "string" ? redactPracticalLog(value) : value;
}
/** An explicit catalog, never a recursive copy of fixture operator/SSH state. */
export async function exportPracticalArtifacts(root: string, output: string, exitCode: number): Promise<void> {
  root = resolve(root); output = resolve(output);
  assert(root !== output && !output.startsWith(root + "/"));
  const metadata = await lstat(root); assert(metadata.isDirectory() && !metadata.isSymbolicLink() && await realpath(root) === root);
  const destination = join(output, "practical"); await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries: { path: string; bytes: number; sha256: string; truncated: boolean }[] = [];
  const copy = async (relative: string, json: boolean) => {
    const path = join(root, relative); let info;
    try { info = await lstat(path); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 32 * 1024 ** 2, "unsafe or oversized diagnostic artifact");
    const bytes = await readFile(path), maximum = 4 * 1024 ** 2;
    const text = json ? JSON.stringify(safeJson(JSON.parse(bytes.toString("utf8"))), null, 2) + "\n" : redactPracticalLog(bytes.subarray(-maximum).toString("utf8"));
    const target = join(destination, relative); await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, text, { mode: 0o600, flag: "wx" });
    entries.push({ path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), truncated: !json && bytes.length > maximum });
  };
  await copy("source.json", true); await copy("roles.txt", false); await copy("practical-runtime.json", true); await copy("selected-host-report.json", true);
  await copy("input.txt", false); await copy("dependency-baseline.json", true); await copy("clone-identities.json", true);
  await copy("qualification.json", true);
  await copy("separate-control-plane.log", false);
  try {
    const stages = join(root, "stages"), stageInfo = await lstat(stages); assert(stageInfo.isDirectory() && !stageInfo.isSymbolicLink());
    for (const run of await readdir(stages, { withFileTypes: true })) {
      if (!run.isDirectory() || !/^run\.[A-Za-z0-9]+$/.test(run.name)) continue;
      for (const file of ["stages.jsonl", "01-control-plane-tools.log", "02-host-build-images-artifacts.log", "03-host-installed-recipes.log", "02-host-baseline-fresh-install.log", "03-host-build-images-artifacts.log", "04-host-installed-recipes.log"])
        await copy(`stages/${run.name}/${file}`, false);
    }
  } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  await writeFile(join(destination, "export.json"), JSON.stringify({ schemaVersion: 1, exitCode, status: exitCode === 0 ? "PASS" : "FAIL", entries,
    catalog: "explicit receipts and reviewed redacted stage diagnostics; operator configs, login keys, cloud-init and private fixture roots excluded" }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [root, output, status] = process.argv.slice(2); assert(root && output && status && /^(?:0|[1-9][0-9]{0,2})$/.test(status) && Number(status) <= 255);
  await exportPracticalArtifacts(root, output, Number(status));
}
