import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { configureNpmUserFile, mergeNpmRegistry, mergePipIndex, parseGuestMirrorPayload } from "../../../../packages/host/plugins/mirrors/src/guest-setup.js";
import { injectMirrorMounts, type GuestProxyConfig } from "../../../../packages/host/plugins/mirrors/src/guest-proxy.js";

const config: GuestProxyConfig = { socket: "/run/docker.sock", engineSocket: "/run/engine.sock", blockedHostnames: ["registry-1.docker.io"],
  files: [{ source: "/home/dim/cache/apt.conf", target: "/etc/apt/apt.conf.d/99dim-mirrors" },
    { source: "/home/dim/cache/npmrc", target: "/run/dim-caches/npmrc" }, { source: "/home/dim/cache/pip.conf", target: "/etc/pip.conf" }],
  environmentDefaults: ["NPM_CONFIG_GLOBALCONFIG=/run/dim-caches/npmrc"] };

it("requires all four private relay endpoints and rejects credential or arbitrary upstream URLs in the guest payload", () => {
  const endpoints = { docker: "http://172.20.0.1:5000/", npm: "http://172.20.0.1:4873/", pypi: "http://172.20.0.1:3141/", apt: "http://172.20.0.1:3142/" };
  const payload = { endpoints, proxy: "reviewed code", setup: "reviewed code", blockedHostnames: ["registry-1.docker.io"] };
  expect(parseGuestMirrorPayload(payload).endpoints.npm).toBe("http://172.20.0.1:4873");
  for (const npm of ["http://token@172.20.0.1:4873", "https://registry.npmjs.org/", "http://172.20.0.1:4873/escape", "http://999.20.0.1:4873/", "http://172.20.0.1:4873/?token=value"]) {
    expect(() => parseGuestMirrorPayload({ ...payload, endpoints: { ...endpoints, npm } })).toThrow();
  }
  expect(() => parseGuestMirrorPayload({ ...payload, endpoints: { docker: endpoints.docker, apt: endpoints.apt } })).toThrow();
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
