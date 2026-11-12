import { request } from "node:http";
import { object, sessionPattern, taskReceipt, type TaskReceipt, type TaskRequest } from "./taskContract.ts";
import type { TaskJournal } from "./taskJournal.ts";

export type TaskConnection = { readonly origin: string; readonly directory: string; readonly serverIdentity: string; readonly authorization: string; readonly lockFile: string };
export type TaskTransport = { readonly directory: string; readonly verify: () => Promise<void>; readonly call: (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ readonly status: number; readonly value: unknown }> };
export function taskTransport(connection: TaskConnection, signal: AbortSignal, verify: () => Promise<void>): TaskTransport {
  const origin = new URL(connection.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw Error("Invalid owned task origin");
  return { directory: connection.directory, verify, async call(method, path, body) {
    if (!/^\/session(?:\/ses_[A-Za-z0-9]{1,100}(?:\/prompt_async)?)?$/.test(path)) throw Error("Invalid task route");
    const url = new URL(path, origin); url.searchParams.set("directory", connection.directory);
    const source = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const call = request(url, { method, agent: false, signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]), headers: { authorization: connection.authorization, ...(source === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(source) }) } }, response => {
        let text = "", bytes = 0;
        response.setEncoding("utf8"); response.once("error", reject);
        response.on("data", (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 32768) call.destroy(Error("Task response limit")); else text += chunk; });
        response.once("end", () => { try { const value: unknown = text ? JSON.parse(text) : null; resolve({ status: response.statusCode ?? 0, value }); } catch { reject(Error("Invalid task response")); } });
      });
      call.once("error", reject); call.end(source);
    });
  } };
}
export async function deliverOpenCodeTask(input: TaskRequest, journal: TaskJournal, transport: TaskTransport): Promise<TaskReceipt> {
  let sessionId = input.target.kind === "session" ? input.target.sessionId : null;
  const receipt = (change: Partial<TaskReceipt>) => taskReceipt(input, { runtime: input.runtime, serverIdentity: input.serverIdentity, messageId: `msg_${input.requestId.replaceAll("-", "")}`, sessionId, ...change });
  await transport.verify();
  switch (input.target.kind) {
    case "new": {
      await journal.mark("create");
      const response = await transport.call("POST", "/session", {});
      if (response.status !== 200 && response.status !== 201) return receipt({ outcome: "outcome-unknown", phase: "create", reason: "transport-unknown" });
      const created = object(response.value);
      if (typeof created.id !== "string" || !sessionPattern.test(created.id) || created.directory !== transport.directory) throw Error("Invalid created session");
      sessionId = created.id; await journal.created(sessionId); break;
    }
    case "session": {
      const response = await transport.call("GET", `/session/${input.target.sessionId}`);
      if (response.status !== 200 || object(response.value).id !== input.target.sessionId || object(response.value).directory !== transport.directory) return receipt({ outcome: "rejected", reason: "invalid-session" });
      break;
    }
  }
  if (sessionId === null) throw Error("Task session unavailable");
  await transport.verify();
  await journal.mark("message", sessionId);
  const response = await transport.call("POST", `/session/${sessionId}/prompt_async`, { messageID: `msg_${input.requestId.replaceAll("-", "")}`, parts: [{ type: "text", text: input.text }], ...(input.mode === "record-only" ? { noReply: true } : {}), ...(input.model === undefined ? {} : { model: input.model }) });
  await transport.verify();
  if (response.status !== 204) return receipt({ outcome: "outcome-unknown", phase: "message", reason: "transport-unknown" });
  return receipt({ outcome: "accepted", phase: "complete", reason: "accepted" });
}
