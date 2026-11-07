import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { buildServiceImage } from "../../../scripts/packages/build-service-image.ts";

vi.mock("../../../scripts/packages/build-service-image.ts", () => ({ buildServiceImage: vi.fn() }));

it.each(["native", "execution"] as const)("independent %s image allowlist accepts the declared graph and rejects unexpected packages and private scopes", async (kind) => {
  const root = resolve(import.meta.dirname, "../../.."), builder = kind === "native" ? "packages/control-plane/deployment/image/build.ts" : "packages/control-plane/plugins/execution-scheduler/image/build.ts";
  vi.mocked(buildServiceImage).mockClear();
  await import(resolve(root, builder));
  const inputs = vi.mocked(buildServiceImage).mock.calls[0]?.[0];
  if (!inputs) throw new Error("image inputs not captured");
  const names = await Promise.all(inputs.packageDirectories.map(async (directory) => {
    const data: unknown = JSON.parse(await readFile(resolve(directory, "../package.json"), "utf8"));
    if (!data || typeof data !== "object" || !("name" in data) || typeof data.name !== "string") throw new Error("invalid manifest");
    return data.name;
  }));
  const shell = await readFile(resolve(root, "scripts/checks/native-idle-service-images-smoke.bash"), "utf8");
  const program = shell.match(/docker exec "\$container" node --input-type=module -e '([\s\S]*?)' "\$\(\[/)?.[1];
  if (!program) throw new Error("independent package assertion missing");
  const execute = (packages: readonly string[]) => {
    const runnable = program.replace('import assert from "node:assert/strict";', 'const assert = require("node:assert/strict");')
      .replace('import { readdirSync } from "node:fs";', `const readdirSync = directory => ${JSON.stringify(packages)}.filter(name => name.startsWith(directory.endsWith("@slop-lab") ? "@slop-lab/" : "@this-project/")).map(name => name.split("/")[1]);`);
    return runInNewContext(runnable, { process: { argv: ["node", kind] }, require: () => assert });
  };
  expect(() => execute(names)).not.toThrow();
  for (const extra of ["@slop-lab/dim-host-core", "@slop-lab/dim-cli", "@slop-lab/dim-web-core", "@slop-lab/dim-host-plugin-execution-worker", "@slop-lab/dim-control-plane-plugin-llm-router", "@this-project/tests"]) {
    expect(() => execute([...names, extra]), extra).toThrow();
  }
  expect(() => execute(names.slice(1))).toThrow();
});
