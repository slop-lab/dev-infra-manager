import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { cleanupOwnedWorkspace } from "./cleanup.js";
import { createLifecycleEnvironment } from "./environment.js";
import { parseWorkspaceList } from "./inspect.js";
import { runCommand } from "./process.js";
import { WorkspaceUi } from "./ui.js";

export async function runConnectionProbe(chromiumPath: string): Promise<void> {
  const environment = await createLifecycleEnvironment(chromiumPath);
  let executionError: unknown;
  try {
    assert.deepEqual(parseWorkspaceList((await environment.cli(["ls", "--json"])).stdout), []);
    await environment.cli(["controller", "restart"]);
    await access(environment.controllerPidPath);
    const source = await runCommand("git", ["ls-remote", environment.repositoryUrl], { timeoutMs: 30_000 });
    assert.match(source.stdout, /refs\/heads\/main/);
    await environment.page.goto(environment.origin);
    const ui = new WorkspaceUi(environment.page);
    await ui.signIn(environment.username, environment.password);
    assert.equal(await ui.rejectInvalidSource("https://user:secret@example.invalid/repo.git", "bad-input"), "server");
    assert.deepEqual(parseWorkspaceList((await environment.cli(["ls", "--json"])).stdout), []);
  } catch (error) {
    executionError = error;
  }
  let cleanupError: unknown;
  try { await cleanupOwnedWorkspace(environment, undefined); } catch (error) { cleanupError = error; }
  try { await environment.close({ removeRoot: cleanupError === undefined }); }
  catch (error) { cleanupError = cleanupError === undefined ? error : new AggregateError([cleanupError, error]); }
  if (cleanupError !== undefined) throw new AggregateError([executionError, cleanupError].filter((error) => error !== undefined), "private connection cleanup failed; evidence retained");
  if (executionError !== undefined) throw executionError;
  console.log("web-workspace-lifecycle: private Web, built CLI/host and owned controller connection probe PASS; no workspace created");
}
