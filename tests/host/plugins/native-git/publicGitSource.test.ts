import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { preparePublicGitSource, publicGitBranch, publicGitUrl } from "../../../../packages/host/plugins/native-git/src/public-git-source.js";
import { publicGitAddress } from "../../../../packages/host/plugins/native-git/src/public-git-network.js";
import { publicGitFixture } from "./publicGitFixture.js";
const fixtures: Awaited<ReturnType<typeof publicGitFixture>>[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(fixtures.splice(0).map((f) => f.close())); });
async function fixture() { const f = await publicGitFixture(); fixtures.push(f); return f; }
it("rejects local, credential-bearing and non-HTTPS source input and special-purpose IPv4/IPv6", () => {
  for (const value of ["/home/private", "file:///private", "ssh://git@github.com/repo", "https://token@github.com/repo", "https://@github.com/repo", "HTTPS://@github.com/repo", "https:////github.com/repo", "https://github.com/repo?", "https://github.com/repo#", "https://localhost/repo", "https://localhost./repo", "https://127.1/repo", "https://[::1]/repo", "https://example.org:8443/repo"]) expect(() => publicGitUrl(value)).toThrow();
  for (const address of ["127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.2.1", "224.0.0.1", "::", "::1", "::ffff:8.8.8.8", "fe80::1", "fc00::1", "2002:7f00:1::", "2001:db8::1", "64:ff9b::7f00:1"]) expect(publicGitAddress(address)).toBe(false);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(publicGitAddress(address)).toBe(true);
  for (const branch of ["--upload-pack=trap", "../main", "a..b", "a.lock/b", "a//b", "a@{1}", "main\n"]) expect(() => publicGitBranch(branch)).toThrow();
});
it("acquires real bare objects through smart HTTP only, pins TLS/DNS and ignores ambient config/credentials without checking out", async () => {
  const f = await fixture(), ambient = join(f.root, "ambient"), trap = join(f.root, "credential-ran"); await mkdir(ambient);
  await writeFile(join(ambient, ".gitconfig"), `[credential]\nhelper = !touch ${trap}\n[url "http://127.0.0.1:9/"]\ninsteadOf = http://127.0.0.1:\n[filter "trap"]\nsmudge = touch ${trap}\n`);
  vi.stubEnv("HOME", ambient); vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "protocol.http.allow"); vi.stubEnv("GIT_CONFIG_VALUE_0", "never"); vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");
  const result = await preparePublicGitSource(f.input, f.dependencies);
  try {
    expect(result.selectedRef).toBe("refs/heads/main");
    expect((await f.git(["--git-dir", result.directory, "rev-parse", "HEAD"])).stdout.trim()).toBe(f.commit);
    expect((await f.git(["--git-dir", result.directory, "config", "core.bare"])).stdout.trim()).toBe("true");
    expect(await readdir(result.directory)).not.toContain("README.md"); await expect(lstat(trap)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.paths).toEqual(["/upstream.git/info/refs?service=git-upload-pack", "/upstream.git/git-upload-pack"]);
    for (const options of f.network) { expect(options).toMatchObject({ protocol: "https:", hostname: "public.example.org", servername: "public.example.org", rejectUnauthorized: true, agent: false }); expect(options.headers).not.toHaveProperty("authorization");
      const answer = await new Promise<unknown>((resolve, reject) => options.lookup!("rebound-host", { all: true }, (error, address) => error ? reject(error) : resolve(address)));
      expect(answer).toEqual([{ address: "8.8.8.8", family: 4 }]);
    }
  } finally { await result.cleanup(); } expect(await readdir(f.scratch)).toEqual([]);
});
it("rejects private or mixed DNS before transport and refuses redirects/dumb alternates, byte overflow and deadline", async () => {
  const f = await fixture();
  for (const addresses of [[{ address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]]) await expect(preparePublicGitSource(f.input, { ...f.dependencies, lookup: async () => addresses })).rejects.toThrow("public addresses");
  expect(f.paths).toEqual([]);
  await expect(preparePublicGitSource(f.input, { ...f.dependencies, lookup: () => new Promise(() => {}), deadlineMilliseconds: 20 })).rejects.toThrow("deadline");
  for (const mode of ["redirect", "dumb"] as const) { f.mode(mode); await expect(preparePublicGitSource(f.input, f.dependencies)).rejects.toThrow("Public Git acquisition failed"); }
  expect(f.paths.every((path) => path === "/upstream.git/info/refs?service=git-upload-pack")).toBe(true);
  f.mode("smart"); await expect(preparePublicGitSource(f.input, { ...f.dependencies, maximumBytes: 16 })).rejects.toThrow("Public Git acquisition failed");
  f.mode("slow"); await expect(preparePublicGitSource(f.input, { ...f.dependencies, deadlineMilliseconds: 30 })).rejects.toThrow();
  expect(await readdir(f.scratch)).toEqual([]);
});
it("selects an explicitly requested branch and cleans up failed or aborted acquisition", async () => {
  const f = await fixture();
  await f.git(["--git-dir", join(f.root, "upstream.git"), "update-ref", "refs/heads/feature/selected", f.commit]);
  const result = await preparePublicGitSource({ ...f.input, branch: "feature/selected" }, f.dependencies); expect(result.selectedRef).toBe("refs/heads/feature/selected"); await result.cleanup();
  await expect(preparePublicGitSource({ ...f.input, branch: "absent" }, f.dependencies)).rejects.toThrow("Public Git acquisition failed");
  await expect(preparePublicGitSource({ ...f.input, signal: AbortSignal.abort() }, f.dependencies)).rejects.toThrow();
  expect(await readdir(f.scratch)).toEqual([]);
});
