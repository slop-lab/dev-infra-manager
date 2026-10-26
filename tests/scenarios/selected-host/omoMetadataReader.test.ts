import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readOmoTeamMetadata } from "./omoMetadataReader.js";

it("reads only bounded runtime membership and redacts all other guest team fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-omo-metadata-")), runtime = join(root, "runtime");
  try {
    for (const run of ["run-one", "run-two"]) {
      await mkdir(join(runtime, run), { recursive: true });
      await writeFile(join(runtime, run, "state.json"), JSON.stringify({ leadSessionId: "ses_parent", status: "active", prompt: "PRIVATE_PAYLOAD",
        members: [{ sessionId: "ses_child", status: "idle", arguments: "PRIVATE_PAYLOAD", output: "PRIVATE_PAYLOAD" }] }), { mode: 0o600 });
    }
    const result = await readOmoTeamMetadata({ baseDirectory: root, maxRuns: 1, maxMembers: 1, deadlineMs: 5000 });
    expect(result.teams).toHaveLength(1); expect(result.truncated).toBe(true); expect(JSON.stringify(result)).not.toContain("PRIVATE_PAYLOAD");
    expect(result.teams[0]?.members).toEqual([{ sessionId: "ses_child", status: "idle" }]);
    const secret = join(root, "auth.json"); await writeFile(secret, '{"password":"PRIVATE_PAYLOAD"}', { mode: 0o600 });
    await mkdir(join(root, "other")); await symlink(runtime, join(root, "other/runtime"));
    expect((await readOmoTeamMetadata({ baseDirectory: join(root, "other"), maxRuns: 1, maxMembers: 1, deadlineMs: 5000 })).unreadable).toBe(true);
    expect(await readFile(secret, "utf8")).toBe('{"password":"PRIVATE_PAYLOAD"}');
  } finally { await rm(root, { recursive: true, force: true }); }
});
