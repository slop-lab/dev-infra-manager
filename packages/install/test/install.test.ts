import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configuredPluginHome,
  defaultInstallPrefix,
  defaultUserConfigPath,
  installDimCli,
  packageNameFromSpecifier
} from "../src/install.js";

describe("@slop-lab/install-dim", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  });

  it("extracts registry package names without guessing path specs", () => {
    expect(packageNameFromSpecifier("@dev-infra-manager/plugin-github")).toBe("@dev-infra-manager/plugin-github");
    expect(packageNameFromSpecifier("@company/internal-git@1.2.3")).toBe("@company/internal-git");
    expect(packageNameFromSpecifier("dim-plugin-example@2")).toBe("dim-plugin-example");
    expect(packageNameFromSpecifier("./plugin.tgz")).toBeUndefined();
  });

  it("installs the matching CLI version under a user-selected prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-installer-test-"));
    temporaryDirectories.push(root);
    const npm = join(root, "npm");
    const argumentsFile = join(root, "arguments");
    await writeFile(npm, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argumentsFile}"\n`);
    await chmod(npm, 0o700);

    const prefix = join(root, "prefix");
    const configPath = join(root, "config", "slop-lab", "dim.json");
    await installDimCli({ prefix, version: "0.1.0", npmCommand: npm, configPath });

    expect((await readFile(argumentsFile, "utf8")).trim().split("\n")).toEqual([
      "install",
      "--global",
      "--prefix",
      prefix,
      "--save-exact",
      "--no-fund",
      "--no-audit",
      "@slop-lab/dim-cli@0.1.0"
    ]);
    expect(defaultInstallPrefix({ HOME: join(root, "home") })).toBe(join(root, "home", ".local"));
    expect(defaultUserConfigPath({ HOME: join(root, "home") })).toBe(
      join(root, "home", ".config", "slop-lab", "dim.json")
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      schemaVersion: 1,
      installPrefix: prefix,
      pluginHome: join(prefix, "share", "dim", "plugins")
    });
    expect(await configuredPluginHome({ DIM_CONFIG_PATH: configPath })).toBe(join(prefix, "share", "dim", "plugins"));
  });
});
