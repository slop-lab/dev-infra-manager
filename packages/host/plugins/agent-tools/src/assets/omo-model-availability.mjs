#!/usr/bin/env node
// @ts-check
// Pinned bootstrap compatibility patch. Remove only after validating upstream's
// retry and call_omo_agent paths against the authenticated model catalog.
import { readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const marker = "// DIM OMO 4.19.4 authenticated model availability v1";
const helper = `
${marker}
function dimAvailableFallback(entry, cache = readProviderModelsCache()) {
  if (!entry || !cache || !Array.isArray(cache.connected) || !cache.models) return;
  const providers = entry.providers.filter((provider) => {
    if (!cache.connected.includes(provider)) return false;
    const models = cache.models[provider];
    if (!Array.isArray(models)) return false;
    const transformed = transformModelForProvider(provider, entry.model);
    return models.some((model) => {
      const id = typeof model === "string" ? model : model?.id;
      return id === entry.model || id === transformed;
    });
  });
  return providers.length ? { ...entry, providers } : undefined;
}
`;

/** @param {string} source @returns {string} */
export function patchOmoModelAvailability(source) {
  if (source.includes(marker)) return source;
  const replacements = [
    [
      "  const fallbackChain = policy?.fallbackChain;",
      "  const fallbackChain = policy?.fallbackChain?.map((entry) => dimAvailableFallback(entry)).filter(Boolean);",
    ],
    [
      "  const fallbackChain = input.fallbackChain;",
      "  const fallbackChain = input.fallbackChain?.map((entry) => dimAvailableFallback(entry)).filter(Boolean);",
    ],
    [
      '    const fallback = state3.fallbackChain[attemptCount];\n    state3.attemptCount++;',
      '    const fallback = dimAvailableFallback(state3.fallbackChain[attemptCount]);\n    state3.attemptCount++;\n    if (!fallback) continue;',
    ],
    [
      '    const candidate = deps.getNextFallback(fallbackChain, selectedAttemptCount);\n    if (!candidate)\n      break;\n    selectedAttemptCount++;',
      '    const rawCandidate = deps.getNextFallback(fallbackChain, selectedAttemptCount);\n    if (!rawCandidate)\n      break;\n    selectedAttemptCount++;\n    const candidate = dimAvailableFallback(rawCandidate, providerModelsCache);\n    if (!candidate) continue;',
    ],
    [
      '  const entry = requirement?.fallbackChain?.[0];\n  if (!entry || entry.providers.length === 0)\n    return;\n  const provider = entry.providers[0];',
      '  const entry = requirement?.fallbackChain?.map((candidate) => dimAvailableFallback(candidate)).find(Boolean);\n  if (!entry || entry.providers.length === 0)\n    return;\n  const provider = entry.providers[0];',
    ],
  ];
  for (const [before, after] of replacements) {
    if (!before || after === undefined || source.split(before).length !== 2) {
      throw new Error("Pinned OMO 4.19.4 source changed; refusing to install an unverified model availability patch");
    }
    source = source.replace(before, after);
  }
  return source + helper;
}

/** @param {string} directory */
export function patchInstalledOmo(directory) {
  const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (metadata.name !== "oh-my-openagent" || metadata.version !== "4.19.4") {
    throw new Error("The model availability patch requires oh-my-openagent 4.19.4");
  }
  const file = join(directory, "dist/index.js");
  const source = readFileSync(file, "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  if (!["e522d513a08d0a6871129dbf3d9c3a79e4871693997fbf34190c4d3fa3d6b4b5", "2cedb93f94f7996bd6711deebfc10fccf6bcc0519b0d39230bffc07a95dc619e"].includes(digest)) {
    throw new Error("Pinned OMO 4.19.4 bundle checksum changed; refusing an unverified patch");
  }
  const patched = patchOmoModelAvailability(source);
  if (patched !== source) writeFileSync(file, patched);
}

/** Refresh before plugin loading, including a first installation with no OMO cache.
 * The models command loads provider integrations but starts no agent session.
 * @param {string} executable
 * @param {string} [cacheHome]
 */
export function refreshOmoModelCatalog(executable, cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")) {
  let output;
  try {
    output = execFileSync(executable, ["models", "--verbose"], { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("Could not read the authenticated OpenCode model catalog; check the configured provider connection and retry");
  }
  /** @type {Record<string, Record<string, unknown>[]>} */
  const models = {};
  let offset = 0;
  const entries = /^([^\s/]+)\/(\S+)\r?\n(\{[\s\S]*?^\})/gm;
  for (const match of output.matchAll(entries)) {
    if (output.slice(offset, match.index).trim()) throw new Error("OpenCode returned an invalid available model catalog");
    const provider = match[1], id = match[2], json = match[3];
    if (!provider || !id || !json) throw new Error("OpenCode returned an incomplete model catalog");
    /** @type {unknown} */
    const metadata = JSON.parse(json);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !("id" in metadata) || metadata.id !== id) throw new Error("OpenCode model metadata does not match its identifier");
    (models[provider] ??= []).push(/** @type {Record<string, unknown>} */ (metadata));
    offset = match.index + match[0].length;
  }
  if (output.slice(offset).trim() || !Object.keys(models).length) throw new Error("OpenCode did not return a valid available model catalog");
  const directory = join(cacheHome, "oh-my-opencode");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const path of [cacheHome, directory]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("OMO cache must be an owned directory without symbolic links");
  }
  const connected = Object.keys(models);
  const updatedAt = new Date().toISOString();
  for (const [name, value] of Object.entries({ "provider-models.json": { models, connected, updatedAt }, "connected-providers.json": { connected, updatedAt } })) {
    const target = join(directory, name), temporary = `${target}.${randomUUID()}`;
    try {
      try {
        const info = lstatSync(target);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("OMO cache file must be an owned regular file");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: omo-model-availability.mjs ABSOLUTE_OMO_PACKAGE_DIRECTORY | --refresh ABSOLUTE_OPENCODE");
  if (directory === "--refresh") {
    const executable = process.argv[3];
    if (!executable) throw new Error("OpenCode executable is required");
    refreshOmoModelCatalog(executable);
  } else patchInstalledOmo(directory);
}
