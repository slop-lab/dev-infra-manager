import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandResult } from "../web-lifecycle/process.js";
import { OperatorInputError, type OwnedWorkspace } from "./config.js";

export async function startSmokeApplication(input: {
  readonly workspace: OwnedWorkspace; readonly ingress: string; readonly challenge: string;
  readonly run: (step: string, args: readonly string[]) => Promise<CommandResult>;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-smoke-application-")), script = path.join(root, "application.mjs");
  try {
    await writeFile(script, `import {createServer} from "node:http";createServer((request,response)=>{if(request.url!=="/health"){response.writeHead(404).end();return;}response.setHeader("content-type","application/json");response.end(JSON.stringify({schemaVersion:1,kind:"dim-smoke-application",challenge:${JSON.stringify(input.challenge)}}));}).listen(3000,"0.0.0.0");\n`);
    await input.run("application source delivery", ["cp", script, `${input.workspace.name}:/home/dim/selected-host-application.mjs`]);
    await input.run("application service registration", ["exec", input.workspace.name, "--", "dim-workspace", "service", "register", "--name", "selected-host-application", "--", "node", "/home/dim/selected-host-application.mjs"]);
    await input.run("application service resume", ["exec", input.workspace.name, "--", "dim-workspace", "service", "resume"]);
    const output: unknown = JSON.parse((await input.run("application external route", ["exec", input.workspace.name, "--", "dim-expose", "--name", "selected-host-application", "--port", "3000", "--ingress", input.ingress])).stdout);
    if (!output || typeof output !== "object" || !("url" in output) || typeof output.url !== "string") throw new OperatorInputError("application route returned no URL");
    await expectSmokeApplication(output.url, input.challenge);
    return output.url;
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function expectSmokeApplication(endpoint: string, challenge: string): Promise<void> {
  const origin = new URL(endpoint);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new OperatorInputError("invalid application endpoint");
  const url = new URL("health", `${origin.href.replace(/\/$/, "")}/`);
  const body = await new Promise<string>((resolve, reject) => {
    const outgoing = (url.protocol === "https:" ? httpsRequest : request)(url, { signal: AbortSignal.timeout(15_000) }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new OperatorInputError(`application health returned HTTP ${response.statusCode}`)); return; }
      let body = ""; response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; if (Buffer.byteLength(body) > 4096) outgoing.destroy(new OperatorInputError("application health response too large")); });
      response.once("error", reject); response.once("end", () => resolve(body));
    });
    outgoing.once("error", reject); outgoing.end();
  });
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 1
    || !("kind" in value) || value.kind !== "dim-smoke-application" || !("challenge" in value) || value.challenge !== challenge) throw new OperatorInputError("external endpoint did not serve the owned smoke application schema/challenge");
}
