import { readFile } from "node:fs/promises";
import { join } from "node:path";
const setup = process.argv[2]; if (!setup) throw new Error("private operator directory required");
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid generated configuration"); return Object.fromEntries(Object.entries(value)); }
const service = object(JSON.parse(await readFile(join(setup, "execution.json"), "utf8")));
const query = object(object(service.credentials).query), runtime = object(JSON.parse(await readFile(join(setup, "acceptance-runtime.json"), "utf8")));
if (typeof query.username !== "string" || typeof query.password !== "string" || typeof runtime.generationId !== "string") throw new Error("invalid private query credentials");
const authorization = `Basic ${Buffer.from(`${query.username}:${query.password}`).toString("base64")}`;
const deadline = Date.now() + 180_000;
for (;;) {
  try {
    const response = await fetch("http://127.0.0.1:18081/v1/jobs", { headers: { authorization, "x-dim-generation-id": runtime.generationId }, signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    if (response.status === 200) break;
    if (response.status === 401 || response.status === 403) throw new Error("separate control-plane query authorization rejected");
  } catch (error) { if (error instanceof Error && error.message.includes("authorization rejected")) throw error; }
  if (Date.now() >= deadline) throw new Error("separate control-plane activation timed out");
  await new Promise((resolve) => setTimeout(resolve, 250));
}
console.log("Separate CP services are active through pinned SSH transport");
