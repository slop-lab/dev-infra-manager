import { link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { artifactTar, paxRecord, tarEntry } from "./artifactTarFixture.js";
import { artifactArchivePath, indexArtifactFiles } from "../../../../packages/host/plugins/execution-worker/src/artifact-source.js";
import { captureExecutionArtifacts } from "../../../../packages/host/plugins/execution-worker/src/artifacts.js";
import { assignment, grant, result } from "../../../contracts/ci/executionFixture.js";
import { NativeOutputCollector } from "../../../../packages/host/plugins/execution-worker/src/output.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-archive-decoder-")); roots.push(root);
  const directory = join(root, "workspace/.dim-ci-artifacts"), path = join(directory, "private.json"), nonce = randomUUID();
  await mkdir(directory, { recursive: true }); const bytes = Buffer.from('{"nonce":"fffccb07-6199-4772-b225-0556b8b61166"}\n');
  new NativeOutputCollector(100, () => {}, join(root, "output")).result();
  await writeFile(path, bytes, { mode: 0o600 }); const archive = { bytes: artifactTar("private.json", bytes) };
  async function run() {
    const index = await indexArtifactFiles(root); await writeFile(artifactArchivePath(root, nonce), archive.bytes, { mode: 0o600, flag: "wx" });
    return { ...result(grant(assignment())), artifactSource: { kind: "archive" as const, nonce, index } };
  }
  async function capture() {
    const completed = await run();
    return { completed, manifest: await captureExecutionArtifacts({ root, pending: join(root, "pending"), result: completed, artifactSource: completed.artifactSource, artifactNonce: nonce }) };
  }
  return { root, directory, path, bytes, archive, nonce, run, capture };
}
const rootHeader = () => tarEntry(".dim-ci-artifacts/", Buffer.alloc(0), "5");

it.each(["traversal", "absolute", "wrong-root", "duplicate", "symlink", "hardlink", "device", "fifo", "global-pax", "gnu-name", "missing", "truncated", "checksum", "size", "trailing", "pax-traversal", "pax-duplicate", "pax-xattr"] as const)("rejects %s archives and publishes no partial file set", async condition => {
  const f = await fixture(), valid = tarEntry(".dim-ci-artifacts/private.json", f.bytes);
  let records = [rootHeader(), valid];
  if (condition === "traversal") records[1] = tarEntry(".dim-ci-artifacts/../private.json", f.bytes);
  if (condition === "absolute") records[1] = tarEntry("/.dim-ci-artifacts/private.json", f.bytes);
  if (condition === "wrong-root") records[1] = tarEntry("other/private.json", f.bytes);
  if (condition === "duplicate") records.push(valid);
  const types = { symlink: "2", hardlink: "1", device: "3", fifo: "6", "global-pax": "g", "gnu-name": "L" };
  if (condition in types) {
    const type = Object.entries(types).find(([key]) => key === condition)?.[1];
    if (type === undefined) throw new Error("missing malicious type"); records[1] = tarEntry(".dim-ci-artifacts/private.json", f.bytes, type);
  }
  if (condition === "missing") records = [rootHeader()];
  if (condition === "checksum") { const changed = Buffer.from(valid); changed[0] = 65; records[1] = changed; }
  if (condition === "size") records[1] = tarEntry(".dim-ci-artifacts/private.json", Buffer.from("wrong"));
  if (condition.startsWith("pax-")) {
    const data = condition === "pax-traversal" ? paxRecord("path", ".dim-ci-artifacts/../private.json")
      : condition === "pax-duplicate" ? Buffer.concat([paxRecord("path", ".dim-ci-artifacts/private.json"), paxRecord("path", ".dim-ci-artifacts/private.json")])
      : paxRecord("SCHILY.xattr.secret", "outside");
    records = [rootHeader(), tarEntry("PaxHeaders/private.json", data, "x"), valid];
  }
  f.archive.bytes = Buffer.concat([...records, Buffer.alloc(condition === "truncated" ? 512 : 1024), ...(condition === "trailing" ? [Buffer.alloc(512, 1)] : [])]);
  const { completed, manifest } = await f.capture();
  expect(completed.result).toBe("success"); expect(manifest.availability).toBe("unavailable");
  expect(manifest.artifacts.map(entry => entry.name)).toEqual(["logs/stdout.log", "logs/stderr.log"]);
  expect(await readdir(join(f.root, "pending"))).toHaveLength(3);
});
it("accepts bounded per-file PAX long UTF-8 paths and timestamps without generic extraction", async () => {
  const f = await fixture(), directory = "nested", name = directory + "/" + "é".repeat(55) + ".json";
  await rm(f.path); await mkdir(join(f.directory, directory)); await writeFile(join(f.directory, name), f.bytes, { mode: 0o600 });
  const pax = Buffer.concat([paxRecord("path", ".dim-ci-artifacts/" + name), paxRecord("mtime", "1.123456789"), paxRecord("atime", "1"), paxRecord("ctime", "-1.5")]);
  f.archive.bytes = Buffer.concat([rootHeader(), tarEntry(".dim-ci-artifacts/nested/", Buffer.alloc(0), "5"), tarEntry("PaxHeaders/file", pax, "x"), tarEntry("truncated-name", f.bytes), Buffer.alloc(1024)]);
  const { manifest } = await f.capture();
  expect(manifest.availability).toBe("complete"); const file = manifest.artifacts.find(entry => entry.name === "files/" + name);
  if (file === undefined) throw new Error("long-path artifact missing");
  expect(await readFile(join(f.root, "pending", file.id))).toEqual(f.bytes);
  expect((await lstat(join(f.directory, name))).mode & 0o777).toBe(0o600);
});
it.each(["numeric-owners", "binary-capability"] as const)("accepts but never restores Moby %s PAX metadata", async condition => {
  const f = await fixture(), pax = condition === "numeric-owners" ? Buffer.concat([paxRecord("uid", "2097152"), paxRecord("gid", "4294967294")]) : paxRecord("SCHILY.xattr.security.capability", Buffer.from([0, 255, 128, 0, 1]));
  f.archive.bytes = Buffer.concat([rootHeader(), tarEntry("PaxHeaders/private.json", pax, "x"), tarEntry(".dim-ci-artifacts/private.json", f.bytes), Buffer.alloc(1024)]);
  const { manifest } = await f.capture(); expect(manifest.availability).toBe("complete");
  const captured = manifest.artifacts.find(entry => entry.name === "files/private.json"); if (!captured) throw new Error("artifact missing");
  expect(await readFile(join(f.root, "pending", captured.id))).toEqual(f.bytes);
  const info = await lstat(join(f.root, "pending", captured.id)); expect(info.uid).toBe(process.getuid?.()); expect(info.mode & 0o777).toBe(0o600);
});
it.each(["symlink", "hardlink"] as const)("rejects a %s archive spool rather than following a replacement", async condition => {
  const f = await fixture(), completed = await f.run(); if (completed.artifactSource === undefined) throw new Error("handoff missing");
  const path = artifactArchivePath(f.root, f.nonce), outside = join(f.root, "outside-archive");
  await writeFile(outside, artifactTar("private.json", f.bytes), { mode: 0o600 });
  if (condition === "symlink") { await rm(path); await symlink(outside, path); } else await link(path, outside + "-link");
  const manifest = await captureExecutionArtifacts({ root: f.root, pending: join(f.root, "pending"), result: completed, artifactSource: completed.artifactSource, artifactNonce: f.nonce });
  expect(manifest.availability).toBe("unavailable"); expect(manifest.artifacts).toHaveLength(2);
});
