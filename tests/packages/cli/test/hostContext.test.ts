import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HostContextStore } from "../../../../core/packages/cli/src/host-context.js";

test("local host inspection works without creating configuration", async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.resolve(), { name: "local" });
    assert.deepEqual(await store.list(), [{ name: "local", current: true }]);
    await assert.rejects(stat(store.file), { code: "ENOENT" });
  });
});

test("SSH contexts persist selection, allow explicit override and fall back to local on removal", async () => {
  await withStore(async (store) => {
    await store.add({ name: "devbox", ssh: "alice@build-host" });
    await store.use("devbox");
    const reopened = new HostContextStore(path.dirname(path.dirname(store.file)));
    assert.deepEqual(await reopened.resolve(), { name: "devbox", ssh: "alice@build-host" });
    assert.deepEqual(await reopened.resolve("local"), { name: "local" });
    assert.equal((await reopened.list()).filter((host) => host.current).length, 1);
    assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    await reopened.remove("devbox");
    assert.deepEqual(await store.resolve(), { name: "local" });
    await assert.rejects(store.resolve("devbox"), /not configured/);
  });
});

test("invalid context edits preserve configuration and cannot replace the local host", async () => {
  await withStore(async (store) => {
    await store.add({ name: "devbox", ssh: "build-host" });
    const before = await readFile(store.file, "utf8");
    await assert.rejects(store.add({ name: "devbox", ssh: "other-host" }), /already exists/);
    await assert.rejects(store.add({ name: "local", ssh: "other-host" }), /local host/);
    await assert.rejects(store.remove("local"), /cannot be removed/);
    await assert.rejects(store.use("missing"), /not configured/);
    for (const ssh of ["", "-oProxyCommand=bad", "host --port 22", "host\ncommand"]) {
      await assert.rejects(store.add({ name: "bad", ssh }), /SSH target/);
    }
    assert.equal(await readFile(store.file, "utf8"), before);
  });
});

test("corrupt context configuration fails without silently selecting a different host", async () => {
  await withStore(async (store) => {
    await store.add({ name: "devbox", ssh: "build-host" });
    for (const content of [
      "{broken",
      JSON.stringify({ current: "missing", hosts: [{ name: "local" }] }),
      JSON.stringify({ current: "local", hosts: [{ name: "local", ssh: "host" }] }),
      JSON.stringify({ current: "local", hosts: [{ name: "local" }], stateRoot: "/obsolete/client/path" }),
      JSON.stringify({ current: "local", hosts: [{ name: "local" }, { name: "local" }] })
    ]) {
      await writeFile(store.file, content);
      await assert.rejects(store.resolve(), /invalid host configuration/);
    }
  });
});

async function withStore(action: (store: HostContextStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "dim-host-context-"));
  try {
    await action(new HostContextStore(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
