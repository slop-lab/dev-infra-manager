import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { fixture, generationId, git, record, reviewer, text } from "../git-repositories/optionalFeaturesFixture.js";
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../../../packages/control-plane/plugins/git-review/src/cli.ts", import.meta.url));
const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
it("uses the generated private reviewer connection for resolve/inspect/approve/revoke and attests its reviewer identity", async () => {
  const f = await fixture(true);
  try {
    await writeFile(join(f.source, "README.md"), "review from the standalone CLI\n"); await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const path = join(f.root, "reviewer.json");
    const connection = { schemaVersion: 1, serviceId: "native-main", baseUrl: f.origin, reviewerId: reviewer.reviewerId, username: reviewer.username, password: reviewer.password, generationId };
    await writeFile(path, JSON.stringify(connection), { mode: 0o600 });
    const invoke = async (operation: string, ...args: string[]) => record(JSON.parse((await execute(process.execPath, ["--import", loader, cli, operation, path, "project", "main", ...args])).stdout));
    const resolved = await invoke("resolve", f.proposalRef);
    const reviewId = text(record(resolved.review), "reviewId");
    expect((await invoke("inspect", reviewId)).status).toBe("pending");
    const approval = await invoke("approve", reviewId);
    expect((await invoke("inspect", reviewId)).status).toBe("approved");
    await invoke("revoke", reviewId, text(approval, "approvalId"));
    expect((await invoke("inspect", reviewId)).status).toBe("revoked");
    await writeFile(path, JSON.stringify({ ...connection, reviewerId: "foreign" }));
    await expect(invoke("approve", reviewId)).rejects.toThrow(/identity attestation failed/);
    await writeFile(path, JSON.stringify(connection)); await chmod(path, 0o644);
    await expect(invoke("approve", reviewId)).rejects.toThrow(/mode-0600/);
    await expect(invoke("promote", reviewId)).rejects.toThrow(/usage: dim-code-review/);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
