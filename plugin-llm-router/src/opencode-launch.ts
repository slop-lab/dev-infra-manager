/** Optional in-guest launch hook. No DIM host module or upstream credential is available here. */
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsoncParser = {
  parse: (text: string, errors: unknown[], options: { allowTrailingComma: boolean }) => unknown;
  modify: (text: string, path: readonly string[], value: unknown, options: { formattingOptions: { insertSpaces: boolean; tabSize: number } }) => unknown;
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid DIM OpenCode launch configuration");
  return value as Record<string, unknown>;
}
async function privateText(file: string, optional = false): Promise<string | undefined> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1 || metadata.size > 1024 * 1024) {
      throw new Error("OpenCode integration configuration must be a bounded regular owned file");
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
async function atomic(file: string, text: string): Promise<void> {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }); }
}
export async function prepareOpenCode(): Promise<Record<string, string>> {
  const mode = process.env.DIM_LLM_ROUTER_OPENCODE_MODE ?? "router";
  if (mode === "providers") return {};
  if (mode !== "router") throw new Error("DIM_LLM_ROUTER_OPENCODE_MODE must be router or providers");
  const home = homedir();
  const connection = record(JSON.parse(await privateText(process.env.DIM_LLM_ROUTER_CONNECTION_FILE ?? join(home, ".config/dim/llm-router.json")) ?? "null"));
  if (!Array.isArray(connection.models)) throw new Error("missing DIM router models");
  const models = connection.models.map(record);
  const selected = models.find(({ id }) => id === connection.defaultModel) ?? models[0];
  if (!selected || typeof selected.id !== "string" || !["responses", "chat"].includes(String(selected.api))
    || connection.defaultModel !== undefined && selected.id !== connection.defaultModel) throw new Error("invalid DIM router default model");
  const model = `dim-${selected.api}/${selected.id}`;
  const content = process.env.OPENCODE_CONFIG_CONTENT === undefined ? {} : record(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT));
  const result: Record<string, string> = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...content, model, small_model: model }) };
  const omoFile = join(home, ".omo/omo.jsonc");
  const source = await privateText(omoFile, true);
  if (source === undefined) return result; // OpenCode without DIM's optional OMO setup.
  const loaded: unknown = createRequire(join(home, ".local/package.json"))(join(home, ".local/lib/node_modules/jsonc-parser"));
  const module = record(loaded);
  if (typeof module.parse !== "function" || typeof module.modify !== "function") throw new Error("invalid pinned JSONC parser; rerun dim tools setup");
  const parser = module as JsoncParser;
  const errors: unknown[] = [];
  const value = record(parser.parse(source, errors, { allowTrailingComma: true }));
  if (errors.length) throw new Error("invalid OMO JSONC; refusing to modify it");
  const profileName = "dim-router";
  const base = value["[opencode]"] === undefined ? {} : record(value["[opencode]"]);
  const agents = new Set(["sisyphus", "hephaestus", "oracle", "librarian", "explore", "multimodal-looker", "metis", "momus", "atlas", "prometheus", "sisyphus-junior"]);
  const categories = new Set(["visual-engineering", "ultrabrain", "deep", "artistry", "quick", "unspecified-low", "unspecified-high", "writing"]);
  for (const layer of [value, base]) {
    for (const key of layer.agents === undefined ? [] : Object.keys(record(layer.agents))) agents.add(key);
    for (const key of layer.categories === undefined ? [] : Object.keys(record(layer.categories))) categories.add(key);
  }
  const route = () => ({ model, fallback_models: [] });
  const profile = { "[opencode]": { agents: Object.fromEntries([...agents].map((name) => [name, route()])),
    categories: Object.fromEntries([...categories].map((name) => [name, route()])), runtime_fallback: false } };
  const metadataFile = join(home, ".config/dim/opencode-omo-profile.json");
  const metadata = await privateText(metadataFile, true);
  const profiles = value.profiles === undefined ? {} : record(value.profiles);
  if (profiles[profileName] !== undefined && JSON.stringify(profiles[profileName]) !== JSON.stringify(profile) && (metadata === undefined || JSON.stringify(profiles[profileName]) !== JSON.stringify(JSON.parse(metadata)))) {
    throw new Error("OMO profiles.dim-router was edited or is not DIM-owned; use providers mode or rename that profile");
  }
  const edits = parser.modify(source, ["profiles", profileName], profile, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  if (!Array.isArray(edits)) throw new Error("invalid JSONC edit output");
  let output = source;
  for (const item of [...edits].reverse()) {
    const edit = record(item);
    if (!Number.isSafeInteger(edit.offset) || !Number.isSafeInteger(edit.length) || typeof edit.offset !== "number"
      || typeof edit.length !== "number" || edit.offset < 0 || edit.length < 0 || edit.offset + edit.length > source.length
      || typeof edit.content !== "string") throw new Error("invalid JSONC edit");
    output = output.slice(0, edit.offset) + edit.content + output.slice(edit.offset + edit.length);
  }
  await mkdir(dirname(metadataFile), { recursive: true, mode: 0o700 });
  if (output !== source) await atomic(omoFile, output);
  await atomic(metadataFile, JSON.stringify(profile));
  result.OMO_PROFILE = profileName;
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareOpenCode())); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
