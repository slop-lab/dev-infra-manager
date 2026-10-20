import { link, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parseGuestMirrorPayload } from "../../../../packages/host/plugins/mirrors/src/guest-setup.js";
import { configureNpmUserFile, mergeNpmRegistry, removeNpmRegistry, clientConfiguration as npmConfiguration } from "../../../../packages/host/plugins/mirrors/src/adapters/npm/client.js";
import { mergePipIndex, removePipIndex, clientConfiguration as pipConfiguration } from "../../../../packages/host/plugins/mirrors/src/adapters/pypi/client.js";
import { removeDockerConfiguration, removeDockerHosts, clientConfiguration as dockerConfiguration } from "../../../../packages/host/plugins/mirrors/src/adapters/docker/client.js";
import { removeExactConfiguration, clientConfiguration as aptConfiguration } from "../../../../packages/host/plugins/mirrors/src/adapters/apt/client.js";
import { injectMirrorMounts, type GuestProxyConfig } from "../../../../packages/host/plugins/mirrors/src/guest-proxy.js";

const config: GuestProxyConfig = { socket: "/run/docker.sock", engineSocket: "/run/engine.sock", blockedHostnames: ["registry-1.docker.io"],
  files: [{ source: "/home/dim/cache/apt.conf", target: "/etc/apt/apt.conf.d/99dim-mirrors" },
    { source: "/home/dim/cache/npmrc", target: "/run/dim-caches/npmrc" }, { source: "/home/dim/cache/pip.conf", target: "/etc/pip.conf" }],
  environmentDefaults: ["NPM_CONFIG_GLOBALCONFIG=/run/dim-caches/npmrc"] };

it("accepts independent reviewed client modules and rejects nonlocal relay endpoints or duplicate identities", () => {
  const client = { kind: "npm", endpoint: "http://172.20.0.1:4873/", source: "reviewed module" };
  const payload = { clients: [client], proxy: "reviewed code", setup: "reviewed code" };
  expect(parseGuestMirrorPayload(payload).clients[0]?.endpoint).toBe("http://172.20.0.1:4873");
  for (const endpoint of ["http://token@172.20.0.1:4873", "https://registry.npmjs.org/", "http://172.20.0.1:4873/escape", "http://999.20.0.1:4873/", "http://172.20.0.1:4873/?token=value"]) {
    expect(() => parseGuestMirrorPayload({ ...payload, clients: [{ ...client, endpoint }] })).toThrow();
  }
  expect(() => parseGuestMirrorPayload({ ...payload, clients: [client, client] })).toThrow();
  expect(parseGuestMirrorPayload({ ...payload, clients: [{ ...client, kind: "future-protocol" }] }).clients).toHaveLength(1);
});

it("builds protocol settings at their owning client boundary for both CI and nested containers", () => {
  const endpoint = "http://172.20.0.1:4873";
  expect(npmConfiguration(endpoint)).toEqual({ files: [{ target: "/etc/npmrc", contents: `registry=${endpoint}/\n` }], environmentDefaults: { NPM_CONFIG_GLOBALCONFIG: "/etc/npmrc" } });
  expect(pipConfiguration(endpoint).files[0]?.target).toBe("/etc/pip.conf");
  expect(pipConfiguration("https://cache.example/simple/").files[0]?.contents).not.toContain("trusted-host");
  expect(aptConfiguration(endpoint).files[0]?.contents).toContain(`Acquire::http::Proxy "${endpoint}"`);
  expect(JSON.parse(dockerConfiguration("https://cache.example/").dockerDaemonConfig)).not.toHaveProperty("insecure-registries");
  expect(JSON.parse(dockerConfiguration(endpoint).dockerDaemonConfig)).toEqual({ "registry-mirrors": [`${endpoint}/`], "insecure-registries": ["172.20.0.1:4873"] });
});

it("merges only its npm default block and preserves explicit user registry, comments and scoped credentials", () => {
  const base = "# User settings\n@private:registry=https://private.example/\n//private.example/:_authToken=${NPM_TOKEN}\n";
  const first = mergeNpmRegistry(base, "http://172.20.0.1:4873");
  expect(first).toContain(base);
  expect(first).toContain("registry=http://172.20.0.1:4873/\n");
  expect(mergeNpmRegistry(first, "http://172.20.0.1:4873")).toBe(first);
  const updated = mergeNpmRegistry(first, "http://172.20.0.1:4874");
  expect(updated).not.toContain(":4873");
  expect(updated.match(/BEGIN DIM CACHE/g)).toHaveLength(1);
  const explicit = `${base}registry=https://explicit.example/\n`;
  expect(mergeNpmRegistry(explicit, "http://172.20.0.1:4873")).toBe(explicit);
  expect(mergeNpmRegistry(`${first}registry=https://explicit.example/\n`, "http://172.20.0.1:4873")).toBe(explicit);
});

it("gives nested package clients read-only defaults while preserving explicit mounts and environment overrides", () => {
  const result = injectMirrorMounts({ Image: "reviewed-image", Env: ["UNRELATED=value"], HostConfig: { Binds: ["/custom/pip.conf:/etc/pip.conf:ro"] } }, config);
  expect(result.Env).toEqual(["UNRELATED=value", "NPM_CONFIG_GLOBALCONFIG=/run/dim-caches/npmrc"]);
  expect(result.HostConfig.Binds).toContain("/home/dim/cache/npmrc:/run/dim-caches/npmrc:ro");
  expect(result.HostConfig.Binds).toContain("/custom/pip.conf:/etc/pip.conf:ro");
  expect(result.HostConfig.Binds).not.toContain("/home/dim/cache/pip.conf:/etc/pip.conf:ro");
  expect(result.Env.some((entry) => entry.startsWith("PIP_CONFIG_FILE="))).toBe(false);
  for (const key of ["NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig"]) {
    expect(injectMirrorMounts({ Env: [`${key}=/explicit/npmrc`, "PIP_INDEX_URL=https://explicit.example/simple/"] }, config).Env)
      .toEqual([`${key}=/explicit/npmrc`, "PIP_INDEX_URL=https://explicit.example/simple/"]);
  }
});

it("adds only its pip global defaults and retains explicit operator policy and unrelated sections", () => {
  const base = "# User settings\n[global]\ncert = /etc/custom-ca.pem\n[install]\ntimeout = 20\n";
  const first = mergePipIndex(base, "http://172.20.0.1:3141");
  expect(first).toContain("cert = /etc/custom-ca.pem\n[install]\ntimeout = 20\n");
  expect(first).toContain("[global]\n# BEGIN DIM CACHE\nindex-url = http://172.20.0.1:3141/\n");
  expect(mergePipIndex(first, "http://172.20.0.1:3141")).toBe(first);
  expect(mergePipIndex(first, "http://172.20.0.1:3142")).not.toContain(":3141");
  const explicit = "[global]\nindex-url = https://explicit.example/simple/\ncert = /etc/custom-ca.pem\n";
  expect(mergePipIndex(explicit, "http://172.20.0.1:3141")).toBe(explicit);
  expect(mergePipIndex("[global]\ntrusted-host = explicit.example\n", "http://172.20.0.1:3141")).toBe("[global]\ntrusted-host = explicit.example\n");
});

it("leaves user-managed npm symlinks and other objects untouched while updating ordinary owned files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dim-npm-client-"));
  const file = path.join(directory, ".npmrc"), target = path.join(directory, "user-config");
  try {
    await writeFile(target, "registry=https://user.example/\n", { mode: 0o600 });
    await symlink(target, file);
    await configureNpmUserFile(file, "http://172.20.0.1:4873");
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("registry=https://user.example/\n");
    await rm(file);
    await mkdir(file);
    await configureNpmUserFile(file, "http://172.20.0.1:4873");
    expect((await lstat(file)).isDirectory()).toBe(true);
    await rm(file, { recursive: true });
    await writeFile(file, "audit=false\n", { mode: 0o600 });
    await configureNpmUserFile(file, "http://172.20.0.1:4873");
    expect(await readFile(file, "utf8")).toBe("audit=false\n# BEGIN DIM CACHE\nregistry=http://172.20.0.1:4873/\n# END DIM CACHE\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("runs a new reviewed client module through user and system hooks without adding a protocol branch", async () => {
  const { prepareGuestClients, configureGuestDaemon, configureGuestUser } = await import("../../../../packages/host/plugins/mirrors/src/guest-setup.js");
  const directory = await mkdtemp(path.join(tmpdir(), "dim-generic-cache-client-"));
  const marker = path.join(directory, "hooks");
  const source = `import { appendFile } from 'node:fs/promises';
export function clientConfiguration(endpoint) { return {files:[{target:'/etc/future/client.conf',contents:'endpoint='+endpoint}],environmentDefaults:{FUTURE_CONFIG:'/etc/future/client.conf'}}; }
export async function configureUser(endpoint) { await appendFile(${JSON.stringify(marker)}, 'user:'+endpoint+'\\n'); }
export async function configureSystem(endpoint) { await appendFile(${JSON.stringify(marker)}, 'system:'+endpoint+'\\n'); }`;
  try {
    const prepared = await prepareGuestClients([{ kind: "future", endpoint: "http://127.0.0.1:3123", source }], directory);
    expect(prepared.environmentDefaults).toEqual(["FUTURE_CONFIG=/etc/future/client.conf"]);
    expect(prepared.files[0]?.target).toBe("/etc/future/client.conf");
    expect(await readFile(prepared.files[0]!.source, "utf8")).toBe("endpoint=http://127.0.0.1:3123");
    await configureGuestUser(prepared.modules, []);
    await configureGuestDaemon({ modules: prepared.modules });
    expect(await readFile(marker, "utf8")).toBe("user:http://127.0.0.1:3123\nsystem:http://127.0.0.1:3123\n");
    const updated = source.replace("'endpoint='+endpoint", "'updated='+endpoint");
    const refreshed = await prepareGuestClients([{ kind: "future", endpoint: "http://127.0.0.1:3123", source: updated }], directory);
    expect(await readFile(refreshed.files[0]!.source, "utf8")).toBe("updated=http://127.0.0.1:3123");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("removes only matching DIM defaults and retains user replacements and previously existing Docker policy", async () => {
  const endpoint = "http://172.20.0.1:4873", other = "http://172.20.0.1:9999";
  const npm = mergeNpmRegistry("# preserved\naudit=false\n", endpoint);
  expect(removeNpmRegistry(npm, endpoint)).toBe("# preserved\naudit=false\n");
  expect(removeNpmRegistry(npm.replace(":4873", ":9999"), endpoint)).toContain(":9999");
  const pip = mergePipIndex("[global]\ncert = /private/ca\n", endpoint);
  expect(removePipIndex(pip, endpoint)).toBe("[global]\ncert = /private/ca\n");
  expect(removePipIndex(pip.replace(":4873", ":9999"), endpoint)).toContain(":9999");
  expect(removeDockerConfiguration({ "registry-mirrors": [`${endpoint}/`, other], "insecure-registries": ["172.20.0.1:4873", "operator:5000"], debug: true }, endpoint, { insecureAdded: true }))
    .toEqual({ "registry-mirrors": [other], "insecure-registries": ["operator:5000"], debug: true });
  expect(removeDockerConfiguration({ "registry-mirrors": [`${endpoint}/`], "insecure-registries": ["172.20.0.1:4873"] }, endpoint,
    { insecureAdded: false, previousMirrors: ["https://previous.example/"] }))
    .toEqual({ "registry-mirrors": ["https://previous.example/"], "insecure-registries": ["172.20.0.1:4873"] });
  expect(removeDockerConfiguration({ "registry-mirrors": [`${endpoint}/`], "insecure-registries": ["172.20.0.1:4873"] }, endpoint, { insecureAdded: true }))
    .toEqual({ "registry-mirrors": [], "insecure-registries": [] });
  expect(removeDockerConfiguration({ "registry-mirrors": [`${endpoint}/`], "insecure-registries": ["172.20.0.1:4873"] }, endpoint,
    { insecureAdded: true, previousMirrors: [] })).toEqual({ "registry-mirrors": [], "insecure-registries": [] });
  expect(removeDockerConfiguration({ "registry-mirrors": [other] }, endpoint, { insecureAdded: true })).toEqual({ "registry-mirrors": [other] });
  expect(removeDockerHosts("127.0.0.1 localhost\n# BEGIN DIM HOST MIRRORS\n127.0.0.1 registry-1.docker.io auth.docker.io\n# END DIM HOST MIRRORS\n")).toBe("127.0.0.1 localhost\n");
  expect(removeDockerHosts("# BEGIN DIM HOST MIRRORS\n127.0.0.2 operator.example\n# END DIM HOST MIRRORS\n")).toContain("operator.example");
  const directory = await mkdtemp(path.join(tmpdir(), "dim-cache-remove-")), file = path.join(directory, "apt.conf");
  try {
    const contents = aptConfiguration(endpoint).files[0]!.contents;
    await writeFile(file, contents);
    await removeExactConfiguration(file, aptConfiguration(other).files[0]!.contents);
    expect(await readFile(file, "utf8")).toBe(contents);
    await removeExactConfiguration(file, contents);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("cleans deselected clients with persisted old module hooks before configuring the retained subset", async () => {
  const { prepareGuestClients, configureGuestDaemon, configureGuestUser, parseActiveGuestClients, removedGuestClients } = await import("../../../../packages/host/plugins/mirrors/src/guest-setup.js");
  const directory = await mkdtemp(path.join(tmpdir(), "dim-cache-subset-")), marker = path.join(directory, "hooks");
  const source = (kind: string) => `import {appendFile} from 'node:fs/promises';
export function clientConfiguration(){return {files:[]};}
export async function configureUser(){await appendFile(${JSON.stringify(marker)},'configure-user:${kind}\\n');}
export async function configureSystem(){await appendFile(${JSON.stringify(marker)},'configure-system:${kind}\\n');}
export async function removeUser(){await appendFile(${JSON.stringify(marker)},'remove-user:${kind}\\n');}
export async function removeSystem(){await appendFile(${JSON.stringify(marker)},'remove-system:${kind}\\n');}`;
  const client = (kind: string) => ({ kind, endpoint: "http://127.0.0.1:3000", source: source(kind) });
  try {
    const all = await prepareGuestClients([client("docker"), client("npm"), client("pypi"), client("apt")], directory);
    const stateFile = path.join(directory, "active-clients.json");
    await writeFile(stateFile, JSON.stringify(all.modules));
    const previous = parseActiveGuestClients(JSON.parse(await readFile(stateFile, "utf8")));
    const subset = await prepareGuestClients([client("npm")], directory), removed = removedGuestClients(previous, subset.modules);
    expect(removed.map(({ kind }) => kind)).toEqual(["docker", "pypi", "apt"]);
    await configureGuestUser(subset.modules, removed);
    await configureGuestDaemon({ modules: subset.modules, removedModules: removed });
    expect(await readFile(marker, "utf8")).toBe("remove-user:docker\nremove-user:pypi\nremove-user:apt\nconfigure-user:npm\nremove-system:docker\nremove-system:pypi\nremove-system:apt\nconfigure-system:npm\n");
    expect(removedGuestClients(subset.modules, subset.modules)).toEqual([]);
    expect(removedGuestClients(subset.modules, [{ ...subset.modules[0]!, endpoint: "http://127.0.0.1:3001" }])).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("refreshes existing mounted config inodes and neutralizes retired clients without overwriting retained defaults", async () => {
  const { prepareGuestClients, removedGuestClients, retireGuestConfigurations } = await import("../../../../packages/host/plugins/mirrors/src/guest-setup.js");
  const directory = await mkdtemp(path.join(tmpdir(), "dim-cache-bind-refresh-"));
  const source = (kind: string, reverse = false) => `export function clientConfiguration(endpoint){return {files:[
    {target:'/etc/${kind}.conf',contents:'index='+endpoint},
    {target:'/etc/${kind}-second.conf',contents:'second='+endpoint} ]${reverse ? ".reverse()" : ""}};}
export function retiredClientConfiguration(){return {files:[{target:'/etc/${kind}.conf',contents:'DIRECT'},{target:'/etc/${kind}-second.conf',contents:''}]};}
export async function configureSystem(){}`;
  const client = (kind: string, port: number, reverse = false) => ({ kind, endpoint: `http://127.0.0.1:${port}`, source: source(kind, reverse) });
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  try {
    const original = await prepareGuestClients([client("npm", 3000), client("apt", 3000)], directory);
    const npm = original.modules[0]!.files[0]!, apt = original.modules[1]!.files[0]!;
    const npmHandle = await open(npm.source, "r"), aptHandle = await open(apt.source, "r"); handles.push(npmHandle, aptHandle);
    const npmInode = (await npmHandle.stat()).ino, aptInode = (await aptHandle.stat()).ino;
    // Existing read-only bind mounts, like these open FDs, retain their source inode.
    const subset = await prepareGuestClients([client("npm", 4000, true)], directory);
    const removed = removedGuestClients(original.modules, subset.modules);
    await retireGuestConfigurations(removed, subset.modules);
    const read = async (handle: Awaited<ReturnType<typeof open>>) => {
      const bytes = Buffer.alloc((await handle.stat()).size);
      await handle.read(bytes, 0, bytes.length, 0); return bytes.toString("utf8");
    };
    expect(subset.modules[0]!.files.find(({ target }) => target === npm.target)?.source).toBe(npm.source);
    expect((await lstat(npm.source)).ino).toBe(npmInode);
    expect((await lstat(apt.source)).ino).toBe(aptInode);
    expect(await read(npmHandle)).toBe("index=http://127.0.0.1:4000");
    expect(await read(aptHandle)).toBe("DIRECT");
    expect(await readFile(original.modules[1]!.files[1]!.source, "utf8")).toBe("");
  } finally { await Promise.all(handles.map((handle) => handle.close())); await rm(directory, { recursive: true, force: true }); }
});

it("does not follow symlinks or write multiply linked configuration sources", async () => {
  const { writeBoundConfiguration } = await import("../../../../packages/host/plugins/mirrors/src/guest-setup.js");
  const directory = await mkdtemp(path.join(tmpdir(), "dim-cache-bound-ownership-")), target = path.join(directory, "target"), file = path.join(directory, "bound");
  try {
    await writeFile(target, "operator"); await symlink(target, file);
    await expect(writeBoundConfiguration(file, "cache")).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("operator");
    await rm(file); await link(target, file);
    await expect(writeBoundConfiguration(file, "cache")).rejects.toThrow(/owned regular file/);
    expect(await readFile(target, "utf8")).toBe("operator");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
