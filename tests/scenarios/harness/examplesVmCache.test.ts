import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cacheCloudInit, discoverVmCaches, dockerCacheConfig, selectedCacheEndpoints } from "../../../scripts/examples/vm-cache.ts";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function temporary() { const path = await mkdtemp(join(tmpdir(), "dim-vm-cache-")); directories.push(path); return path; }
it("selects public guest endpoints without loading client modules and rewrites only loopback HTTP", () => {
  expect(selectedCacheEndpoints([{kind:"apt",endpoint:"http://127.0.0.1:8123",module:"/private/not-loaded"},{kind:"npm",endpoint:"https://nas.example/npm/"}], true)).toEqual({apt:"http://10.0.2.2:8123/",npm:"https://nas.example/npm/"});
  for (const endpoint of ["http://user:secret@example.test/", "http://example.test/?secret=x", "http://example.test/#fragment", "http://example.test/apt/"]) {
    expect(() => selectedCacheEndpoints({schemaVersion:1,endpoints:{apt:endpoint}})).toThrow();
  }
  expect(() => selectedCacheEndpoints({schemaVersion:1,endpoints:{npm:"https://localhost:8123"}})).toThrow(/certificate/);
});
it("gives explicit catalogs precedence, fails closed on malformed selection, and uses direct only when absent", async () => {
  const home = await temporary();
  expect(await discoverVmCaches({HOME:home})).toEqual({source:"direct",endpoints:{}});
  const state = join(home,".local/state/dim/host-mirrors"); await mkdir(state,{recursive:true});
  await writeFile(join(state,"active-clients.json"), JSON.stringify([{kind:"npm",endpoint:"https://workspace.example/"}]));
  expect((await discoverVmCaches({HOME:home})).source).toBe("workspace");
  const catalog = join(home,"selected.json"); await writeFile(catalog,JSON.stringify({schemaVersion:1,endpoints:{docker:"http://nas.example:5000"}}));
  expect(await discoverVmCaches({HOME:home,DIM_EXAMPLES_CACHE_CATALOG:catalog})).toEqual({source:"explicit",endpoints:{docker:"http://nas.example:5000/"}});
  await writeFile(catalog,"{}"); await expect(discoverVmCaches({HOME:home,DIM_EXAMPLES_CACHE_CATALOG:catalog})).rejects.toThrow();
});
it("keeps direct bootstrap untouched and emits only selected protocol defaults with DockerHub fallback blocked", () => {
  expect(cacheCloudInit({})).toBe("");
  const snippet = cacheCloudInit({apt:"http://nas.example:3142/",npm:"http://nas.example:4873/",docker:"http://nas.example:5000/"});
  expect(snippet).toContain('Acquire::https::Proxy "DIRECT"');
  expect(snippet).toContain("NPM_CONFIG_GLOBALCONFIG=/etc/npmrc");
  expect(snippet).toContain("127.0.0.1 registry-1.docker.io auth.docker.io");
  expect(snippet).toContain("path: /etc/environment\n    owner: root:root\n    permissions: '0644'\n    append: true");
  expect(snippet).not.toContain("HTTP_PROXY");
  const original = {features:{"containerd-snapshotter":true},runtimes:{sysbox:{path:"sysbox-runc"}}};
  expect(dockerCacheConfig(original,{docker:"http://nas.example:5000/"})).toEqual({...original,"registry-mirrors":["http://nas.example:5000/"],"insecure-registries":["nas.example:5000"]});
  expect(() => dockerCacheConfig({"registry-mirrors":[]},{docker:"http://nas.example:5000/"})).toThrow(/pre-existing/);
});
it("rejects bootstrap resume when the selected catalog identity changes", async () => {
  const directory = await temporary();
  const helper = resolve(import.meta.dirname,"../../../scripts/lib/bootstrap-host-state.bash");
  const {stdout} = await promisify(execFile)("bash",["-c",`set -euo pipefail
source "$1"
role=ordinary source_sha=reviewed expected_version=0.10.0 operator_uid=$(id -u)
resume_marker_root="$2/state"; resume_marker="$resume_marker_root/ubuntu-vm.state"
cache_catalog_sha256=$(printf old | sha256sum | cut -d' ' -f1)
dim_write_marker awaiting-login absent
cache_catalog_sha256=$(printf changed | sha256sum | cut -d' ' -f1)
if dim_open_bootstrap_state; then exit 99; fi
printf rejected
`,"cache-test",helper,directory]);
  expect(stdout).toBe("rejected");
});
