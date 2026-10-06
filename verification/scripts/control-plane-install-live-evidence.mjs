import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const bundleResources = [
  ["network", "dim-control-plane"],
  ["volume", "dim-control-plane-native-git-data"],
  ["volume", "dim-control-plane-ordinary-ci-data"],
  ["container", "dim-control-plane-native-git-1"],
  ["container", "dim-control-plane-ordinary-ci-1"]
];
const ordinaryBusinessTables = [
  "native_admissions", "native_attempt_assignments", "native_event_replay_fences", "review_job_replay_fences",
  "native_event_inbox", "demands", "claim_receipts", "claims", "capacity_fences", "host_results",
  "report_outbox", "terminal_details"
];

export async function captureDenialEvidence(context) {
  const [sources, state, resources, containers] = await Promise.all([
    sourceEvidence(context), stateEvidence(context.stateRoot),
    resourceEvidence(context.runner), containerEvidence(context.runner)
  ]);
  return { sources, state, resources, containers };
}

export function assertDenialEvidence(name, status, before, after) {
  assert.deepEqual(after.sources, before.sources, `${name} changed operator source bytes or metadata`);
  assert.deepEqual(after.state, before.state, `${name} changed installed state`);
  assert.deepEqual(after.resources, before.resources, `${name} changed bundle resource identities`);
  assert.deepEqual(after.containers, before.containers, `${name} left a Docker probe container`);
  console.log(`denial-evidence ${JSON.stringify({
    case: name, status,
    sourcesBefore: before.sources, sourcesAfter: after.sources,
    stateBefore: before.state, stateAfter: after.state,
    bundleBefore: before.resources, bundleAfter: after.resources,
    probeResidue: "absent"
  })}`);
}

export async function captureAuthorityBoundaryState(runner) {
  const [nativeGit, ordinaryCi, resources, sockets] = await Promise.all([
    captureAuthorityServiceState(runner, "nativeGit"),
    captureAuthorityServiceState(runner, "ordinaryCi"),
    captureAuthorityResources(runner),
    captureAuthoritySockets(runner)
  ]);
  return { services: { nativeGit, ordinaryCi }, ...resources, sockets };
}

export async function captureAuthorityServiceState(runner, service) {
  const definition = service === "nativeGit"
    ? {
        container: "dim-control-plane-native-git-1", user: "10001:10001",
        root: "/var/lib/dim-native-git", database: "/var/lib/dim-native-git/native-idle.sqlite3",
        tables: ["bundle_activation"]
      }
    : {
        container: "dim-control-plane-ordinary-ci-1", user: "10002:10002",
        root: "/var/lib/dim-ordinary-ci", database: "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3",
        tables: ["bundle_activation", ...ordinaryBusinessTables]
      };
  const source = `
    import {createHash} from "node:crypto";
    import {readdirSync,statSync} from "node:fs";
    import {join} from "node:path";
    import {DatabaseSync} from "node:sqlite";
    const root=${JSON.stringify(definition.root)};
    const database=new DatabaseSync(${JSON.stringify(definition.database)},{readOnly:true});
    const tables=${JSON.stringify(definition.tables)};
    const counts=Object.fromEntries(tables.map((table)=>[table,database.prepare("SELECT COUNT(*) AS count FROM "+table).get().count]));
    const activation=database.prepare("SELECT generation_id,activation_token_sha256 FROM bundle_activation ORDER BY generation_id").all();
    database.close();
    const protectedRefs=[];
    const visit=(path)=>{for(const entry of readdirSync(path)){const child=join(path,entry);const stat=statSync(child);if(entry==="refs"||entry==="packed-refs")protectedRefs.push(child);if(stat.isDirectory())visit(child);}};
    visit(root);
    process.stdout.write(JSON.stringify({counts,entries:readdirSync(root).sort(),protectedRefs,activationGenerations:activation.map((row)=>row.generation_id),activationDigest:createHash("sha256").update(JSON.stringify(activation)).digest("hex")}));
  `;
  const state = JSON.parse((await authorityDocker(runner, [
    "container", "exec", "--user", definition.user, definition.container,
    "node", "--input-type=module", "--eval", source
  ])).stdout);
  if (service === "nativeGit") {
    assert.deepEqual(state.entries, [".dim-native-git-owner.sqlite3", "native-idle.sqlite3", "state-format.json"]);
  } else assert.equal(ordinaryBusinessTables.every((table) => state.counts[table] === 0), true);
  assert.deepEqual(state.protectedRefs, []);
  return state;
}

export function assertIdleAuthorityBoundary(state) {
  assert.deepEqual(state.sockets, [[], []]);
  assert.equal(state.services.nativeGit.protectedRefs.length, 0);
  assert.equal(ordinaryBusinessTables.every((table) => state.services.ordinaryCi.counts[table] === 0), true);
  for (const runtime of state.runtime) {
    assert.equal(runtime.mounts.some(({ Destination }) => Destination === "/run/docker.sock"), false);
    assert.equal(runtime.privileged, false);
    assert.equal(runtime.readonlyRootfs, true);
  }
}

async function captureAuthorityResources(runner) {
  const [networkResult, volumesResult, containersResult, projectResources] = await Promise.all([
    authorityDocker(runner, ["network", "inspect", "dim-control-plane"]),
    authorityDocker(runner, ["volume", "inspect", "dim-control-plane-native-git-data", "dim-control-plane-ordinary-ci-data"]),
    authorityDocker(runner, ["container", "inspect", "dim-control-plane-native-git-1", "dim-control-plane-ordinary-ci-1"]),
    Promise.all(["container", "volume", "network"].map(async (kind) => {
      const args = kind === "container" ? [kind, "ls", "--all"] : [kind, "ls"];
      const format = kind === "container" ? "{{.ID}}|{{.Names}}" : kind === "volume" ? "{{.Name}}" : "{{.ID}}|{{.Name}}";
      const result = await authorityDocker(runner, [...args, "--filter", "label=dim.project", "--format", format]);
      return result.stdout.trim().split("\n").filter(Boolean).sort();
    }))
  ]);
  const networkValue = JSON.parse(networkResult.stdout)[0];
  const network = {
    id: networkValue.Id,
    containers: Object.entries(networkValue.Containers).map(([id, value]) => [id, value.Name]).sort()
  };
  const volumes = JSON.parse(volumesResult.stdout).map(({ Name, Mountpoint, CreatedAt }) => ({ Name, Mountpoint, CreatedAt }));
  const runtime = JSON.parse(containersResult.stdout).map((value) => ({
    id: value.Id,
    image: value.Config.Image,
    mounts: value.Mounts.map(({ Type, Name, Source, Destination, RW }) => ({ Type, Name, Source, Destination, RW }))
      .sort((left, right) => left.Destination.localeCompare(right.Destination)),
    networks: Object.keys(value.NetworkSettings.Networks).sort(),
    privileged: value.HostConfig.Privileged,
    readonlyRootfs: value.HostConfig.ReadonlyRootfs
  }));
  return { network, volumes, runtime, projectResources };
}

async function captureAuthoritySockets(runner) {
  const source = `
    import {readFileSync} from "node:fs";
    const forbidden=/(agent|workspace|controller|docker\\.sock)/i;
    process.stdout.write(JSON.stringify(readFileSync("/proc/net/unix","utf8").split("\\n").filter((line)=>forbidden.test(line))));
  `;
  return await Promise.all([
    ["10001:10001", "dim-control-plane-native-git-1"],
    ["10002:10002", "dim-control-plane-ordinary-ci-1"]
  ].map(async ([user, container]) => JSON.parse((await authorityDocker(runner, [
    "container", "exec", "--user", user, container, "node", "--input-type=module", "--eval", source
  ])).stdout)));
}

async function authorityDocker(runner, args) {
  const result = await runner.run({ args, timeoutMilliseconds: 30_000, maximumOutputBytes: 256 * 1024 });
  assert.equal(result.exitCode, 0, `docker ${args.slice(0, 3).join(" ")} failed: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return result;
}

async function sourceEvidence(context) {
  const entries = {
    installer: context.configPath,
    nativeConfig: context.sources.nativeGit,
    nativeReadiness: context.sources.nativeReadiness,
    ordinaryConfig: context.sources.ordinaryCi,
    ordinaryReadiness: context.sources.ordinaryReadiness
  };
  return Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([name, path]) => {
    const metadata = await lstat(path);
    const kind = metadata.isSymbolicLink() ? "symlink" : metadata.isFile() ? "file" : "other";
    return [name, `${kind}:uid=${metadata.uid}:mode=${(metadata.mode & 0o777).toString(8)}:sha256=${digest(await readFile(path))}`];
  })));
}

async function stateEvidence(stateRoot) {
  const install = await optionalFile(join(stateRoot, "install.json"));
  const compose = await optionalFile(join(stateRoot, "compose.yml"));
  const generations = await optionalDirectory(join(stateRoot, "generations"));
  if (install === undefined && compose === undefined && (generations === undefined || generations.length === 0)) return "absent";
  let generationId = "unpublished";
  if (install !== undefined) {
    const parsed = JSON.parse(install.toString("utf8"));
    generationId = typeof parsed.generationId === "string" ? parsed.generationId : "invalid";
  }
  return {
    installSha256: install === undefined ? "absent" : digest(install),
    composeSha256: compose === undefined ? "absent" : digest(compose),
    generationId,
    generationDirectories: generations ?? []
  };
}

async function resourceEvidence(runner) {
  return Object.fromEntries(await Promise.all(bundleResources.map(async ([kind, name]) => {
    const format = kind === "volume" ? "{{.Name}}" : "{{.Id}}";
    const result = await runner.run({
      args: [kind, "inspect", name, "--format", format],
      timeoutMilliseconds: 10_000,
      maximumOutputBytes: 4096
    });
    return [`${kind}:${name}`, result.exitCode === 0 ? result.stdout.trim() : "absent"];
  })));
}

async function containerEvidence(runner) {
  const result = await runner.run({
    args: ["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}|{{.Names}}"],
    timeoutMilliseconds: 10_000,
    maximumOutputBytes: 64 * 1024
  });
  assert.equal(result.exitCode, 0, `container residue inspection failed: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return result.stdout.trim().split("\n").filter(Boolean).sort();
}

async function optionalFile(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function optionalDirectory(path) {
  try {
    return (await readdir(path)).sort().map((entry) => basename(entry));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
