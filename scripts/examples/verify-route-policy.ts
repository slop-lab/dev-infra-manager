import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
const source = process.argv[2]; if (!source) throw new Error("policy server source is required");
const root = await mkdtemp(join(tmpdir(), "dim-example-policy-")), socketPath = join(root, "policy.sock");
const child = spawn(process.execPath, [source, socketPath], { stdio: ["ignore", "pipe", "inherit"] });
const post = (requestedSubdomain: string) => new Promise<unknown>((resolve, reject) => {
  const pending = request({ socketPath, method: "POST", path: "/", headers: { "content-type": "application/json" } }, (response) => {
    const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); } });
  }); pending.setTimeout(2000, () => pending.destroy(new Error("route policy request timed out")));
  pending.on("error", reject); pending.end(JSON.stringify({ requestedSubdomain }));
});
try {
  const deadline = Date.now() + 5000;
  for (;;) { try { await post("ready"); break; } catch (error) { if (Date.now() >= deadline || child.exitCode !== null) throw error; await new Promise((resolve) => setTimeout(resolve, 20)); } }
  assert.deepEqual(await post("docs"), { allow: true, subdomain: "shared-docs" });
  const denied = await post("private"); assert(denied && typeof denied === "object" && "allow" in denied && denied.allow === false);
  console.log("example policy: actual Unix HTTP allow/rewrite and denial passed");
} finally {
  if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "exit"); child.kill("SIGTERM"); await closed; }
  await rm(root, { recursive: true, force: true });
}
