import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseTaskRequest, taskReceipt } from "../../../../packages/host/plugins/agent-tools/src/execution/taskContract.ts";
import { lookupTask, runTaskRequest, type TaskJournal } from "../../../../packages/host/plugins/agent-tools/src/execution/taskJournal.ts";
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function home() { const root = await mkdtemp(join(tmpdir(), "dim-task-journal-")); roots.push(root); return root; }
const request = () => parseTaskRequest({ workspaceId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", requestId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", runtime: "opencode", serverIdentity: "a".repeat(64), target: { kind: "new" }, mode: "record-only", text: "Explicit fixture input" });
it("replays accepted receipts without calling delivery again and never persists task plaintext", async () => {
  const root = await home(), input = request(), deliver = vi.fn(async (journal: TaskJournal) => { await journal.mark("create"); await journal.created("ses_created"); await journal.mark("message", "ses_created"); return taskReceipt(input, { outcome: "accepted", reason: "accepted", phase: "complete", serverIdentity: input.serverIdentity, sessionId: "ses_created", messageId: `msg_${input.requestId.replaceAll("-", "")}` }); });
  const first = await runTaskRequest(root, input, deliver);
  expect(await runTaskRequest(root, input, deliver)).toEqual(first); expect(deliver).toHaveBeenCalledTimes(1);
  expect(await readFile(join(root, ".local/state/dim-agent-tools/tasks", input.workspaceId, input.requestId, "claim.json"), "utf8")).not.toContain(input.text);
  expect((await runTaskRequest(root, { ...input, text: input.text + " changed" }, deliver)).outcome).toBe("conflict"); expect(deliver).toHaveBeenCalledTimes(1);
});
it("retains the created session and uncertain dispatch permanently after a simulated accepted-but-lost response", async () => {
  const root = await home(), input = request(), deliver = vi.fn(async (journal: TaskJournal) => { await journal.mark("create"); await journal.created("ses_created"); await journal.mark("message", "ses_created"); throw Error("Connection disappeared after acceptance"); });
  expect(await runTaskRequest(root, input, deliver)).toMatchObject({ outcome: "outcome-unknown", phase: "message", sessionId: "ses_created" });
  expect(await runTaskRequest(root, input, deliver)).toMatchObject({ outcome: "outcome-unknown", phase: "message" }); expect(deliver).toHaveBeenCalledTimes(1);
});
it("allows only one concurrent request owner and treats an empty crash claim as unknown", async () => {
  const root = await home(), input = request(); let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const deliver = vi.fn(async () => { await gate; return taskReceipt(input); });
  const first = runTaskRequest(root, input, deliver), second = runTaskRequest(root, input, deliver); release();
  await Promise.all([first, second]); expect(deliver).toHaveBeenCalledTimes(1);
  const crashed = { ...input, requestId: "cccccccc-cccc-4ccc-cccc-cccccccccccc" };
  await mkdir(join(root, ".local/state/dim-agent-tools/tasks", input.workspaceId, crashed.requestId));
  expect((await runTaskRequest(root, crashed, deliver)).outcome).toBe("outcome-unknown"); expect(deliver).toHaveBeenCalledTimes(1);
});

it.each(["missing-claim", "contradictory-claim", "noninitial-valid-claim", "wrong-session-marker"])("never trusts terminal acceptance with %s", async damage => {
  const root = await home(), input = request(), path = join(root, ".local/state/dim-agent-tools/tasks", input.workspaceId, input.requestId);
  const deliver = vi.fn(async (journal: TaskJournal) => { await journal.mark("create"); await journal.created("ses_created"); await journal.mark("message", "ses_created"); return taskReceipt(input, { outcome: "accepted", reason: "accepted", phase: "complete", serverIdentity: input.serverIdentity, sessionId: "ses_created", messageId: `msg_${input.requestId.replaceAll("-", "")}` }); });
  expect((await runTaskRequest(root, input, deliver)).outcome).toBe("accepted");
  switch (damage) {
    case "missing-claim": await rm(join(path, "claim.json")); break;
    case "contradictory-claim": { const row = JSON.parse(await readFile(join(path, "claim.json"), "utf8")); row.receipt.outcome = "accepted"; await writeFile(join(path, "claim.json"), JSON.stringify(row)); break; }
    case "noninitial-valid-claim": { const row = JSON.parse(await readFile(join(path, "claim.json"), "utf8")); row.receipt = { ...row.receipt, outcome: "accepted", phase: "complete", reason: "accepted", sessionId: "ses_created" }; await writeFile(join(path, "claim.json"), JSON.stringify(row)); break; }
    case "wrong-session-marker": await writeFile(join(path, "session-created.json"), JSON.stringify({ sessionId: "ses_foreign" })); break;
  }
  expect((await lookupTask(root, input)).outcome).toBe("outcome-unknown");
  expect((await runTaskRequest(root, input, deliver)).outcome).toBe("outcome-unknown"); expect(deliver).toHaveBeenCalledTimes(1);
});

it("syncs an ancestor created by another paused request before delivering a concurrent request", async () => {
  const root = await home(), input = request(), tasks = join(root, ".local/state/dim-agent-tools/tasks");
  let entered: () => void = () => {}, release: () => void = () => {}, syncs = 0;
  const paused = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await realOpen(path, flags, mode);
    if (String(path) === tasks) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { syncs++; if (syncs === 1) { entered(); await resume; } await sync(); });
    }
    return handle;
  });
  const first = runTaskRequest(root, input, async () => taskReceipt(input));
  try {
    await paused;
    const other = { ...input, requestId: "cccccccc-cccc-4ccc-cccc-cccccccccccc" };
    await runTaskRequest(root, other, async () => { expect(syncs).toBeGreaterThanOrEqual(2); return taskReceipt(other); });
  } finally { release(); await first; vi.mocked(fs.open).mockImplementation(realOpen); }
});
