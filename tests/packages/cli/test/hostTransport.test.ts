import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  callHost, decodeHostRequest, encodeHostRequest, hostInvocation, HostTransportError
} from "../../../../core/packages/cli/src/host-transport.js";

const peer = fileURLToPath(new URL("./fixtures/host-peer.mjs", import.meta.url));
const localCommand = { file: process.execPath, args: [peer] };
const local = { name: "local" };
const execFileAsync = promisify(execFile);

test("record operations use the real local host process and preserve structured input", async () => {
  const request = { operation: "create", input: { name: "dev", source: { url: "https://example.com/repo.git" } } };
  const result = await callHost(local, request, { localCommand });
  assert.deepEqual(result, { request });
});

test("host failures preserve stderr and status, and malformed responses fail clearly", async () => {
  let diagnostic = "";
  const stderr = new Writable({ write(chunk, _encoding, callback) { diagnostic += String(chunk); callback(); } });
  await assert.rejects(callHost(local, { operation: "fail" }, { localCommand, stderr }), (error: unknown) => {
    assert.ok(error instanceof HostTransportError);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /source acquisition failed/);
    return true;
  });
  assert.equal(diagnostic, "source acquisition failed\n");
  await assert.rejects(callHost(local, { operation: "invalid" }, { localCommand }), /invalid JSON result/);
  await assert.rejects(callHost(local, { operation: "list" }, {
    localCommand: { file: "/missing/dim-host-process" }
  }), /could not run command/);
});

test("SSH shell execution cannot interpret command input, source URLs or names as shell code", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dim-host-shell-"));
  const marker = path.join(directory, "executed");
  const dangerous = `a'; touch '${marker}'; echo '$(touch ${marker})\n\`touch ${marker}\`;$HOME`;
  const request = { operation: "create", input: { name: dangerous, source: { url: dangerous } } };
  try {
    const invocation = hostInvocation({ name: "remote", ssh: "alice@build-host" }, request);
    assert.deepEqual(invocation.args.slice(0, 3), ["-T", "--", "alice@build-host"]);
    const command = invocation.args[3];
    assert.ok(command);
    await writeFile(path.join(directory, "dim"), `#!/bin/sh\nexec ${shellArgument(process.execPath)} ${shellArgument(peer)} "$@"\n`);
    await chmod(path.join(directory, "dim"), 0o700);
    const result = await execFileAsync("/bin/sh", ["-c", command], {
      env: { ...process.env, PATH: directory }
    });
    assert.deepEqual(JSON.parse(result.stdout), { request });
    await assert.rejects(stat(marker), { code: "ENOENT" });
    assert.equal(hostInvocation({ name: "remote", ssh: "build-host" }, request, { terminal: true }).args[0], "-tt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exec transport streams stdin, stdout and stderr without JSON conversion and keeps exit status", async () => {
  const transport = new URL("../../../../core/packages/cli/src/host-transport.ts", import.meta.url).href;
  const script = `import { streamHost } from ${JSON.stringify(transport)};
    process.exitCode = await streamHost({name:'local'}, {operation:'exec', input:{exitCode:17}},
      {localCommand: ${JSON.stringify(localCommand)}});`;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end("raw input\n{not a JSON response}\n");
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(status, 17);
  assert.equal(stdout, "raw input\n{not a JSON response}\n");
  assert.match(stderr, /exec stderr/);
});

test("SSH bootstraps mise in non-interactive PATH and reports a missing installation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dim-host-mise-"));
  const bin = path.join(directory, "bin");
  const home = path.join(directory, "home");
  const userBin = path.join(home, ".local", "bin");
  const request = { operation: "list" };
  const command = hostInvocation({ name: "remote", ssh: "build-host" }, request).args[3]!;
  await mkdir(bin);
  await mkdir(userBin, { recursive: true });
  const mise = `#!/bin/sh
test "$1" = exec && test "$2" = -- && test "$3" = dim || exit 99
shift 3
exec ${shellArgument(process.execPath)} ${shellArgument(peer)} "$@"
`;
  try {
    await writeFile(path.join(bin, "mise"), mise, { mode: 0o700 });
    const fromPath = await execFileAsync("/bin/sh", ["-c", command], { env: { PATH: bin, HOME: home } });
    assert.deepEqual(JSON.parse(fromPath.stdout), { request });
    await rm(path.join(bin, "mise"));
    await writeFile(path.join(userBin, "mise"), mise, { mode: 0o700 });
    const fromHome = await execFileAsync("/bin/sh", ["-c", command], { env: { PATH: bin, HOME: home } });
    assert.deepEqual(JSON.parse(fromHome.stdout), { request });
    await rm(path.join(userBin, "mise"));
    await assert.rejects(execFileAsync("/bin/sh", ["-c", command], { env: { PATH: bin, HOME: home } }), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && "stderr" in error);
      assert.equal(error.code, 127);
      assert.match(String(error.stderr), /dim installer install core/);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("request envelope validation rejects malformed encoding and non-object input", () => {
  assert.deepEqual(decodeHostRequest(encodeHostRequest({ operation: "list" })), { operation: "list" });
  for (const encoded of ["", "not+base64/", Buffer.from('{"operation":"exec","input":[]}').toString("base64url")]) {
    assert.throws(() => decodeHostRequest(encoded), /invalid host request/);
  }
  assert.throws(() => hostInvocation({ name: "remote", ssh: "-oProxyCommand=bad" }, { operation: "list" }), /SSH target/);
});

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
