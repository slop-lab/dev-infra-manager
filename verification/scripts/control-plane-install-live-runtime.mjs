import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { request } from "node:http";

export async function assertDockerCli(runner) {
  const paths = ["/", "/usr", "/usr/local", "/usr/local/bin", "/usr/local/bin/docker"];
  const pathEvidence = await Promise.all(paths.map(async (path) => {
    const metadata = await lstat(path);
    assert.equal(metadata.uid, 0);
    assert.equal(metadata.mode & 0o022, 0);
    if (path.endsWith("/docker")) assert.equal(metadata.isFile(), true);
    else assert.equal(metadata.isDirectory(), true);
    return `${path}:uid=${metadata.uid}:mode=${(metadata.mode & 0o777).toString(8)}`;
  }));
  const version = await runner.run({ args: ["--version"], timeoutMilliseconds: 5000, maximumOutputBytes: 1024 });
  assert.equal(version.exitCode, 0);
  assert.match(version.stdout, /^Docker version 29\.1\.3,/);
  console.log(`docker-cli path=/usr/local/bin/docker chain=${pathEvidence.join(",")} client=29.1.3`);
}

export function createLiveRuntime(input) {
  async function docker(args) {
    const result = await input.runner.run({ args, timeoutMilliseconds: 300000, maximumOutputBytes: 1024 * 1024 });
    assert.equal(result.exitCode, 0, `docker ${args.slice(0, 3).join(" ")} failed: ${result.stderr}`);
    return result;
  }

  async function inspectService(service, user) {
    const name = `dim-control-plane-${service}-1`;
    const value = JSON.parse((await docker(["container", "inspect", name])).stdout)[0];
    assert.equal(value.Config.User, user);
    assert.equal(value.HostConfig.ReadonlyRootfs, true);
    assert.equal(value.HostConfig.Privileged, false);
    assert.deepEqual(value.HostConfig.CapDrop, ["ALL"]);
    assert.deepEqual(value.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
    assert.equal(Object.hasOwn(value.NetworkSettings.Networks, "dim-control-plane"), true);
    assert.equal(value.Mounts.some((mount) => mount.Destination === "/run/docker.sock"), false);
    assert.equal(value.Mounts.length, 4);
    const ready = await docker(["container", "exec", "--user", user, value.Id, "/usr/local/bin/dim-service", "ready"]);
    assert.equal(ready.stdout + ready.stderr, "");
    return { id: value.Id, image: value.Config.Image, generationId: value.Config.Cmd[2] };
  }

  async function runtimeSnapshot() {
    const [nativeGit, ordinaryCi] = await Promise.all([
      inspectService("native-git", "10001:10001"), inspectService("ordinary-ci", "10002:10002")
    ]);
    const network = JSON.parse((await docker(["network", "inspect", "dim-control-plane"])).stdout)[0];
    assert.deepEqual(Object.values(network.Containers).map((entry) => entry.Name).sort(), [
      "dim-control-plane-native-git-1", "dim-control-plane-ordinary-ci-1"
    ]);
    return { nativeGit, ordinaryCi };
  }

  async function assertDeployment(installed, expectedImages) {
    assert.equal(installed.record.nativeGitImage, expectedImages.nativeGit);
    assert.equal(installed.record.ordinaryCiImage, expectedImages.ordinaryCi);
    const runtime = await runtimeSnapshot();
    assert.equal(runtime.nativeGit.generationId, installed.record.generationId);
    assert.equal(runtime.ordinaryCi.generationId, installed.record.generationId);
    assert.equal(runtime.nativeGit.image, expectedImages.nativeGit);
    assert.equal(runtime.ordinaryCi.image, expectedImages.ordinaryCi);
  }

  async function volumeSnapshot() {
    const value = JSON.parse((await docker([
      "volume", "inspect", "dim-control-plane-native-git-data", "dim-control-plane-ordinary-ci-data"
    ])).stdout);
    return value.map(({ Name, Mountpoint, CreatedAt }) => ({ Name, Mountpoint, CreatedAt }));
  }

  async function sentinel(service, user, database, insert) {
    const generation = createHash("sha256").update(`sentinel-${input.deploymentId}`).digest("hex");
    const token = createHash("sha256").update(`sentinel-token-${input.deploymentId}`).digest("hex");
    const source = insert
      ? `import {DatabaseSync} from "node:sqlite";const d=new DatabaseSync(${JSON.stringify(database)});d.prepare("INSERT INTO bundle_activation VALUES (?, ?)").run(${JSON.stringify(generation)},${JSON.stringify(token)});d.close()`
      : `import {DatabaseSync} from "node:sqlite";const d=new DatabaseSync(${JSON.stringify(database)},{readOnly:true});const r=d.prepare("SELECT count(*) AS n FROM bundle_activation WHERE generation_id=? AND activation_token_sha256=?").get(${JSON.stringify(generation)},${JSON.stringify(token)});d.close();if(r.n!==1)process.exit(1)`;
    await docker(["container", "exec", "--user", user, `dim-control-plane-${service}-1`, "node", "--input-type=module", "-e", source]);
  }

  async function writeSentinels() {
    await sentinel("native-git", "10001:10001", "/var/lib/dim-native-git/native-idle.sqlite3", true);
    await sentinel("ordinary-ci", "10002:10002", "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3", true);
  }

  async function assertSentinels() {
    await sentinel("native-git", "10001:10001", "/var/lib/dim-native-git/native-idle.sqlite3", false);
    await sentinel("ordinary-ci", "10002:10002", "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3", false);
  }

  async function assertBusinessUnavailable(port) {
    const response = await new Promise((resolve, reject) => {
      const outgoing = request({ host: "127.0.0.1", port, path: "/v1/projects/live-smoke", method: "POST" }, resolve);
      outgoing.once("error", reject);
      outgoing.end();
    });
    response.resume();
    assert.equal(response.statusCode, 503);
  }

  async function projectResources() {
    return await Promise.all(["container", "volume", "network"].map(async (kind) => {
      const args = kind === "container" ? [kind, "ls", "--all"] : [kind, "ls"];
      const format = kind === "container" ? "{{.ID}}|{{.Names}}" : kind === "volume" ? "{{.Name}}" : "{{.ID}}|{{.Name}}";
      const result = await docker([...args, "--filter", "label=dim.project", "--format", format]);
      return result.stdout.trim().split("\n").filter(Boolean).sort();
    }));
  }

  return {
    assertBusinessUnavailable,
    assertDeployment,
    assertSentinels,
    docker,
    projectResources,
    runtimeSnapshot,
    volumeSnapshot,
    writeSentinels
  };
}
