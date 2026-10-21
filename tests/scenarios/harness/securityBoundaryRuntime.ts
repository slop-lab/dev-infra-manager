import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, parseBoundaryConfiguration, startBoundary } from "../../../examples/features/security-review/boundary.ts";

const directory = await mkdtemp(join(tmpdir(), "dim-security-boundary-"));
const secretFile = join(directory, "operator-token");
// Generated fixture only: no real credential or host DIM installation is read.
const token = randomBytes(32).toString("hex");
await writeFile(secretFile, token, { mode: 0o600 });
const configuration = parseBoundaryConfiguration(JSON.parse(await readFile(new URL("../../../examples/features/security-review/repository/.dim/security-boundary.json", import.meta.url), "utf8")));
assert.equal(configuration.services["agent-dind"].secretAccess, false);
assert.equal(configuration.services["secure-dind"].secretAccess, true);
let boundary: Awaited<ReturnType<typeof startBoundary>> | undefined;
try {
  boundary = await startBoundary(configuration, secretFile);
  const agent = boundary.containers["agent-dind"], secure = boundary.containers["secure-dind"];
  assert.equal(await docker(["exec", secure, "cat", "/run/secrets/service-token"]), token);
  await assert.rejects(docker(["exec", secure, "sh", "-ec", ": > /run/secrets/service-token"]));
  assert.equal(await docker(["exec", secure, "cat", "/run/secrets/service-token"]), token);
  await docker(["exec", agent, "sh", "-ec", "test ! -e /run/secrets/service-token; test ! -e /run/host-services/docker.sock; test -z \"$(docker ps -aq)\""]);
  const daemon = async (id: string) => docker(["exec", id, "docker", "info", "--format", "{{.ID}}"]);
  assert.notEqual(await daemon(agent), await daemon(secure));
  await assert.rejects(docker(["exec", agent, "docker", "inspect", secure]));
  await assert.rejects(docker(["exec", agent, "docker", "-H", "tcp://secure-dind:2375", "info"]));
  const [inspection] = JSON.parse(await docker(["inspect", agent])) as { Config: { Env: string[] }; HostConfig: { Privileged: boolean; NetworkMode: string }; Mounts: { Source: string }[] }[];
  assert(inspection);
  assert.equal(inspection.HostConfig.Privileged, false);
  assert.equal(inspection.HostConfig.NetworkMode, "none");
  assert(!inspection.Config.Env.some((value) => value.includes(token)));
  assert(!inspection.Mounts.some(({ Source }) => Source === secretFile || Source.endsWith("docker.sock")));
  // The untrusted role can control its own daemon, but has no secure daemon or token.
  await docker(["exec", agent, "docker", "volume", "create", "agent-owned"]);
  assert.equal(await docker(["exec", secure, "docker", "volume", "ls", "--quiet"]), "");
  console.log("PASS secure-dind: private dummy token, separate daemons, no agent mount/credential/service-network access");
} finally {
  try { await boundary?.close(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
