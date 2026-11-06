import { OperatorInputError } from "./config.js";
export type ExposureTarget = { readonly workspace: string; readonly ingress: string; readonly port: number; readonly protocol: "http" | "https"; readonly containers: readonly string[] };

export function selectExposureUrl(value: unknown, expected: ExposureTarget): string {
  const envelope = object(value, ["urls"]);
  if (!Array.isArray(envelope.urls) || envelope.urls.length !== 1) throw new OperatorInputError("exposure must return exactly one owned public route");
  const entry = object(envelope.urls[0], ["id", "workspace", "ingress", "subdomain", "target", "path", "url", "permalink", "approval", "createdAt"]);
  if (typeof entry.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(entry.id)
    || entry.workspace !== expected.workspace || entry.ingress !== expected.ingress) throw new OperatorInputError("exposure does not identify the exact owned workspace and ingress");
  const target = object(entry.target, ["containers", "port", "protocol"]);
  if (!Array.isArray(target.containers) || target.containers.length > 1 || target.containers.length !== expected.containers.length
    || !target.containers.every((container: unknown, index: number) => typeof container === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container) && container === expected.containers[index])
    || target.port !== expected.port || !Number.isInteger(target.port) || target.protocol !== expected.protocol) throw new OperatorInputError("exposure target differs from the exact requested service");
  if (entry.approval !== "approved" && entry.approval !== "not-required") throw new OperatorInputError("exposure is not approved for publication");
  if (typeof entry.createdAt !== "string" || entry.createdAt.length > 40 || !Number.isFinite(Date.parse(entry.createdAt))
    || new Date(entry.createdAt).toISOString() !== entry.createdAt) throw new OperatorInputError("exposure timestamp is invalid");
  if (entry.subdomain !== undefined && (typeof entry.subdomain !== "string" || entry.subdomain.length > 253
    || !entry.subdomain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) throw new OperatorInputError("exposure subdomain is invalid");
  if (entry.path !== undefined && (typeof entry.path !== "string" || !entry.path.startsWith("/") || /[\\\x00-\x20\x7f?#]/.test(entry.path))) throw new OperatorInputError("exposure path is invalid");
  if (entry.permalink !== undefined) safeUrl(entry.permalink);
  return safeUrl(entry.url);
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new OperatorInputError("exposure is not the production public urls envelope");
  return Object.fromEntries(Object.entries(value));
}
function safeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\\\x00-\x20\x7f?#]/.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|2e|2f|5c)/i.test(value) || /\/(?:\.|\.\.)(?:\/|$)/.test(value)
    || /^[a-z]+:\/\/[^/]*@/i.test(value)) throw new OperatorInputError("exposure URL is unsafe");
  let url: URL;
  try { url = new URL(value); decodeURIComponent(url.pathname); }
  catch { throw new OperatorInputError("exposure URL is malformed"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new OperatorInputError("exposure URL must be credential-free HTTP(S)");
  return value;
}
