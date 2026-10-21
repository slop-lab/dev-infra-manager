import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { jobEnvironmentScript } from "../../../../packages/host/plugins/execution-worker/src/backends/containers.js";

function run(defaults: Readonly<Record<string, string>>, explicit: NodeJS.ProcessEnv = {}, image: readonly string[] = []) {
  return execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", jobEnvironmentScript(defaults, image) + "exec /usr/bin/env"],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...explicit } }).split("\n");
}
it("makes plugin defaults visible inside the job and preserves explicit keys irrespective of casing", () => {
  const defaults = { NPM_CONFIG_GLOBALCONFIG: "/etc/npmrc" };
  expect(run(defaults)).toContain("NPM_CONFIG_GLOBALCONFIG=/etc/npmrc");
  const selected = run(defaults, { npm_config_globalconfig: "/project/npmrc" });
  expect(selected).toContain("npm_config_globalconfig=/project/npmrc");
  expect(selected.some((entry) => entry.startsWith("NPM_CONFIG_GLOBALCONFIG="))).toBe(false);
  expect(run(defaults, { NPM_CONFIG_GLOBALCONFIG: "" })).toContain("NPM_CONFIG_GLOBALCONFIG=");
});
it("preserves QEMU job image environment before applying defaults without interpreting values as shell code", () => {
  const literal = "a'b\n$(printf injected); $HOME";
  const selected = run({ NPM_CONFIG_GLOBALCONFIG: "/etc/npmrc", EXTRA: literal }, {},
    ["npm_config_globalconfig=/image/npmrc", "IMAGE_SETTING=expected"]);
  expect(selected).toContain("npm_config_globalconfig=/image/npmrc");
  expect(selected.some((entry) => entry.startsWith("NPM_CONFIG_GLOBALCONFIG="))).toBe(false);
  expect(selected).toContain("IMAGE_SETTING=expected");
  expect(selected.join("\n")).toContain(`EXTRA=${literal}`);
});
it("rejects invalid variable names and NUL values before generating an executable job environment", () => {
  expect(() => jobEnvironmentScript({ "BAD;command": "x" })).toThrow("invalid host job environment");
  expect(() => jobEnvironmentScript({ GOOD: "x\0y" })).toThrow("invalid host job environment");
  expect(() => jobEnvironmentScript({}, ["MALFORMED"])).toThrow("invalid job image environment");
});
