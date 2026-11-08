import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "../../..");
const bootstrap = join(repository, "scripts/checks/lib/bootstrap-download.bash");
const cache = join(repository, "packages/host/plugins/vm/scripts/artifact-cache.bash");
const pins = join(repository, "scripts/lib/bootstrap-ubuntu-pins.bash");
const bytes = "reviewed public artifact\n", digest = createHash("sha256").update(bytes).digest("hex");
const headers = ["Accept: application/octet-stream", "X-GitHub-Api-Version: 2022-11-28"];
type Kind = "bootstrap" | "cache";
async function fixture(kind: Kind) {
  const root = await mkdtemp(join(tmpdir(), "dim-github-assets-")), bin = join(root, "bin"), calls = join(root, "calls");
  await mkdir(bin); await writeFile(join(root, "payload"), bytes);
  const curl = join(bin, "curl");
  await writeFile(curl, `#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2),f=process.env.CALLS;let n=0;try{n=fs.readFileSync(f,'utf8').trim().split('\\n').length}catch{}fs.appendFileSync(f,JSON.stringify(a)+'\\n');if(!['Accept: application/octet-stream','X-GitHub-Api-Version: 2022-11-28'].every(h=>a[a.indexOf(h)-1]==='--header')){process.stdout.write('406');process.exit(22)}if(process.env.MODE==='fail'){process.stderr.write('SECRET_URL_HEADER_ENV');process.stdout.write('504');process.exit(22)}const p=a[a.indexOf('--output')+1];fs.copyFileSync(process.env.PAYLOAD,p);if(process.env.MODE==='corrupt')fs.appendFileSync(p,'corrupt');if(process.env.MODE==='resume'&&n===0){process.stdout.write('200');process.exit(33)}process.stdout.write('200');\n`, { mode: 0o700 });
  const helper = join(root, "helper.bash");
  await writeFile(helper, (await readFile(kind === "bootstrap" ? bootstrap : cache, "utf8")).replaceAll("/usr/bin/curl", JSON.stringify(curl)));
  const output = join(root, "output"), directory = join(root, "cache");
  const run = (values: readonly string[] = headers, mode = "ok", offline?: string, label = "pnpm") => spawnSync("bash", ["-c",
    kind === "bootstrap" ? 'source "$1"; shift; dim_artifact_kind="$DIM_TEST_LABEL"; dim_bootstrap_download "$@"' : 'source "$1"; shift; dim_artifact_kind="$DIM_TEST_LABEL"; dim_artifact_cache "$@"',
    "fixture", helper, "https://api.github.com/repos/pnpm/pnpm/releases/assets/271328060", digest, ...(kind === "bootstrap" ? [output] : []), ...values],
  { encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH, CALLS: calls, PAYLOAD: join(root, "payload"), MODE: mode,
    DIM_TEST_LABEL: label, DIM_ARTIFACT_CACHE: directory, DIM_BOOTSTRAP_DOWNLOAD_CACHE: offline ?? "" } });
  const invoked = async (): Promise<string[][]> => { try { return (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]); } catch { return []; } };
  return { root, output, directory, run, invoked, close: () => rm(root, { recursive: true, force: true }) };
}

it("selects official pinned assets and resets request headers for ordinary downloads", () => {
  const r = spawnSync("bash", ["-c", 'source "$1"; for kind in pnpm just node sysbox; do dim_bootstrap_artifact "$kind" amd64; printf "%s|%s|%s|%s\\n" "$kind" "$dim_artifact_url" "$dim_artifact_sha256" "${dim_artifact_headers[*]}"; done', "fixture", pins], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const lines = r.stdout.trim().split("\n");
  expect(lines[0]).toBe("pnpm|https://api.github.com/repos/pnpm/pnpm/releases/assets/271328060|e1cab530ea8252eb90e4add71d95838fd6f2656e6977f120df5ecb6f5b2822e0|" + headers.join(" "));
  expect(lines[1]).toBe("just|https://api.github.com/repos/casey/just/releases/assets/315676085|6a3003f68fa4d86ada8afe33830a88ffdb6c2fcaff4e5a840b1cb90eaf6f46fc|" + headers.join(" "));
  expect(lines[2]).toMatch(/^node\|https:\/\/nodejs.org\/.*\|$/);
  expect(lines[3]).toMatch(/^sysbox\|https:\/\/downloads.nestybox.com\/.*\|$/);
});

for (const kind of ["bootstrap", "cache"] as const) {
  it(`${kind} forwards literal headers, verifies bytes and publishes a private artifact`, async () => {
    const f = await fixture(kind);
    try {
      const r = f.run(); expect(r.status, r.stderr).toBe(0);
      const path = kind === "bootstrap" ? f.output : r.stdout.trim();
      expect(await readFile(path, "utf8")).toBe(bytes); expect((await stat(path)).mode & 0o777).toBe(0o600);
      const [args] = await f.invoked(); if (!args) throw Error("curl was not invoked");
      for (const value of headers) expect(args[args.indexOf(value) - 1]).toBe("--header");
      expect(args).toContain("--proto-redir"); expect(args).toContain("=https");
      if (kind === "cache") { expect(f.run().status).toBe(0); expect(await f.invoked()).toHaveLength(1); }
    } finally { await f.close(); }
  });
  it(`${kind} reports only closed download identity and numeric failure`, async () => {
    const f = await fixture(kind);
    try { const r = f.run(headers, "fail"); expect(r.status).toBe(22); expect(r.stderr).toContain((kind === "bootstrap" ? "artifact=pnpm" : "sha256=" + digest) + " curl-exit=22 http-status=504"); expect(r.stderr).not.toMatch(/SECRET|https:|Accept|2022-11-28/); }
    finally { await f.close(); }
  });
  it(`${kind} never publishes mismatched bytes despite a successful HTTP response`, async () => {
    const f = await fixture(kind);
    try {
      const r = f.run(headers, "corrupt"); expect(r.status).toBe(1); expect(r.stderr).toContain("SHA-256 mismatch");
      await expect(readFile(kind === "bootstrap" ? f.output : join(f.directory, digest))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.close(); }
  });
  it(`${kind} rejects header indirection, flags, controls and bounds before any download`, async () => {
    const f = await fixture(kind);
    try {
      for (const values of [["@private-file"], ["--insecure"], ["-Bad: value"], ["Bad Name: value"], ["Accept: value\r\nInjected: yes"], ["Accept: value\tbad"], ["Accept: " + "x".repeat(1024)], Array(9).fill("X-Test: value"), Array(5).fill("X-Test: " + "x".repeat(900))]) {
        const r = f.run(values); expect(r.status, JSON.stringify(values)).toBe(2);
      }
      expect(await f.invoked()).toHaveLength(0);
    } finally { await f.close(); }
  });
}
it("cache range rejection reconnects once without changing headers or digest identity", async () => {
  const f = await fixture("cache");
  try {
    const r = f.run(headers, "resume"); expect(r.status, r.stderr).toBe(0); expect(r.stdout.trim()).toBe(join(f.directory, digest));
    const calls = await f.invoked(); expect(calls).toHaveLength(2); expect(calls[0]).toContain("--continue-at"); expect(calls[1]).not.toContain("--continue-at");
    for (const args of calls) for (const value of headers) expect(args[args.indexOf(value) - 1]).toBe("--header");
  } finally { await f.close(); }
});
it("bootstrap explicit cache remains offline and copies before verifying with request headers present", async () => {
  const f = await fixture("bootstrap"), input = join(f.root, "offline");
  try {
    await mkdir(input); await writeFile(join(input, digest), bytes);
    const r = f.run(headers, "fail", input); expect(r.status, r.stderr).toBe(0); expect(await f.invoked()).toHaveLength(0);
    expect(await readFile(f.output, "utf8")).toBe(bytes);
  } finally { await f.close(); }
});

it("generic VM cache ignores unrelated ambient bootstrap labels", async () => {
  const f = await fixture("cache");
  try { const r = f.run(headers, "ok", undefined, "foreign-invalid-label"); expect(r.status, r.stderr).toBe(0); expect(r.stderr).not.toContain("foreign-invalid-label"); }
  finally { await f.close(); }
});

it("bootstrap seed owns the artifact label when the generic cache download fails", async () => {
  const f = await fixture("cache"), source = join(f.root, "repository");
  try {
    const lib = join(source, "scripts/checks/lib"), pinsDirectory = join(source, "scripts/lib"), cacheDirectory = join(source, "packages/host/plugins/vm/scripts");
    for (const directory of [lib, pinsDirectory, cacheDirectory]) await mkdir(directory, { recursive: true });
    await writeFile(join(lib, "bootstrap-artifact-seed.bash"), await readFile(join(repository, "scripts/checks/lib/bootstrap-artifact-seed.bash")));
    await writeFile(join(cacheDirectory, "artifact-cache.bash"), await readFile(cache));
    await writeFile(join(pinsDirectory, "bootstrap-ubuntu-pins.bash"), (await readFile(pins, "utf8")).replace("14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647", digest));
    await mkdir(f.directory); await writeFile(join(f.directory, digest), bytes);
    const r = spawnSync("bash", ["-c", 'source "$1"; BOOTSTRAP_WORK_ROOT="$2"; examples_artifacts_prepare', "fixture", join(lib, "bootstrap-artifact-seed.bash"), f.root], {
      encoding: "utf8", env: { ...process.env, PATH: join(f.root, "bin") + ":" + process.env.PATH, DIM_ARTIFACT_CACHE: f.directory, CALLS: join(f.root, "calls"), PAYLOAD: join(f.root, "payload"), MODE: "fail" }
    });
    expect(r.status).toBe(22); expect(r.stderr).toContain("[bootstrap] artifact=pnpm cache-exit=22");
    expect(r.stderr).toContain("http-status=504"); expect(r.stderr).not.toMatch(/SECRET|https:|Accept/);
    expect(await f.invoked()).toHaveLength(1);
  } finally { await f.close(); }
});
