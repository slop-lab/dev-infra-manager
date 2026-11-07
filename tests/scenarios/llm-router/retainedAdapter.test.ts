import { chmod, link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixture, hostPlugin } from "./attachmentFixture.js";
import { reviewedLegacyAdapter } from "./legacyAdapterFixture.js";

it("retires exact reviewed private old adapter bytes only after modern helper publication and preserves retained identity/user state", async () => {
  const f = await fixture(), old = join(f.home, ".config/opencode/plugins/dim-llm-router.js"), modern = join(f.home, ".config/opencode/plugins/dim-llm-router.mjs");
  const connection = await readFile(f.connectionPath), beforeModern = await readFile(modern);
  const user = join(f.home, ".omo/omo.jsonc"); await mkdir(join(f.home, ".omo")); await writeFile(user, '{"models":["unrelated/original"]}\n', { mode: 0o600 });
  await writeFile(old, reviewedLegacyAdapter, { mode: 0o600 });
  const ready = hostPlugin.workspaceReady; if (!ready) throw new Error("workspace hook missing");
  await ready(f.workspace, f.context);
  await expect(readFile(old)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(modern)).toEqual(beforeModern); expect(await readFile(f.connectionPath)).toEqual(connection);
  expect(await readFile(user, "utf8")).toBe('{"models":["unrelated/original"]}\n');
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM principals").get()?.n)).toBe(1);
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM requests").get()?.n)).toBe(0);
});

it.each(["edited", "symlink", "hardlink", "mode"] as const)("preserves %s old adapter state and gives an actionable safe-retirement refusal", async (kind) => {
  const f = await fixture(), old = join(f.home, ".config/opencode/plugins/dim-llm-router.js"), saved = join(f.root, "user-file.js");
  const connection = await readFile(f.connectionPath), bytes = kind === "edited" ? Buffer.concat([reviewedLegacyAdapter, Buffer.from("\n// user modification\n")]) : reviewedLegacyAdapter;
  await writeFile(saved, bytes, { mode: 0o600 });
  switch (kind) {
    case "symlink": await symlink(saved, old); break;
    case "hardlink": await link(saved, old); break;
    case "edited": await writeFile(old, bytes, { mode: 0o600 }); break;
    case "mode": await writeFile(old, bytes, { mode: 0o600 }); await chmod(old, 0o644); break;
  }
  const ready = hostPlugin.workspaceReady; if (!ready) throw new Error("workspace hook missing");
  await expect(ready(f.workspace, f.context)).rejects.toThrow(/obsolete.*adapter.*inspect/i);
  expect(await readFile(old)).toEqual(bytes); expect(await readFile(saved)).toEqual(bytes);
  expect(await readFile(f.connectionPath)).toEqual(connection);
});

it("retires only the active HOME-relative custom XDG adapter", async () => {
  const f = await fixture(), config = join(f.home, "custom-config"), plugins = join(config, "opencode/plugins");
  await mkdir(plugins, { recursive: true, mode: 0o700 });
  const inactive = join(f.home, ".config/opencode/plugins/dim-llm-router.js"), active = join(plugins, "dim-llm-router.js");
  await writeFile(inactive, reviewedLegacyAdapter, { mode: 0o600 }); await writeFile(active, reviewedLegacyAdapter, { mode: 0o600 });
  f.guestEnvironment.XDG_CONFIG_HOME = config;
  const ready = hostPlugin.workspaceReady; if (!ready) throw new Error("workspace hook missing");
  await ready(f.workspace, f.context);
  await expect(readFile(active)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(inactive)).toEqual(reviewedLegacyAdapter);
  expect((await readFile(join(plugins, "dim-llm-router.mjs"))).length).toBeGreaterThan(0);
});

it("preserves an old adapter edited between the hash read and retirement recheck", async () => {
  const f = await fixture(), old = join(f.home, ".config/opencode/plugins/dim-llm-router.js"), preload = join(f.root, "edit-before-recheck.cjs");
  await writeFile(old, reviewedLegacyAdapter, { mode: 0o600 });
  await writeFile(preload, `const fs=require("node:fs"),read=fs.readSync;let seen=false;
fs.readSync=function(fd,...args){const result=read.call(this,fd,...args);if(!seen&&fs.readlinkSync("/proc/self/fd/"+fd)===${JSON.stringify(old)}){seen=true;fs.appendFileSync(${JSON.stringify(old)},"\\n// concurrent user edit\\n")}return result};`);
  Object.assign(f.guestEnvironment, { NODE_OPTIONS: `--require=${preload}` });
  const ready = hostPlugin.workspaceReady; if (!ready) throw new Error("workspace hook missing");
  await expect(ready(f.workspace, f.context)).rejects.toThrow(/obsolete.*adapter.*inspect/i);
  expect(await readFile(old)).toEqual(Buffer.concat([reviewedLegacyAdapter, Buffer.from("\n// concurrent user edit\n")]));
});

it("preserves a user replacement appearing after the last pathname ownership check", async () => {
  const f = await fixture(), old = join(f.home, ".config/opencode/plugins/dim-llm-router.js"), preload = join(f.root, "replace-after-check.cjs");
  await writeFile(old, reviewedLegacyAdapter, { mode: 0o600 });
  await writeFile(preload, `const fs=require("node:fs"),lstat=fs.lstatSync;let replaced=false;
fs.lstatSync=function(file,...args){const result=lstat.call(this,file,...args);if(!replaced&&typeof file==="string"&&file.startsWith("/proc/self/fd/")&&file.endsWith("/dim-llm-router.js")){replaced=true;fs.renameSync(${JSON.stringify(old)},${JSON.stringify(old + ".reviewed")});fs.writeFileSync(${JSON.stringify(old)},"// concurrent replacement\\n",{mode:384})}return result};`);
  Object.assign(f.guestEnvironment, { NODE_OPTIONS: `--require=${preload}` });
  const ready = hostPlugin.workspaceReady; if (!ready) throw new Error("workspace hook missing");
  await expect(ready(f.workspace, f.context)).rejects.toThrow(/obsolete.*adapter.*inspect/i);
  expect(await readFile(old, "utf8")).toBe("// concurrent replacement\n");
  expect(await readFile(old + ".reviewed")).toEqual(reviewedLegacyAdapter);
});
