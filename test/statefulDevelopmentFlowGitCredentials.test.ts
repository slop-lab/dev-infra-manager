import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const statefulSmoke = resolve(import.meta.dirname, "../scripts/stateful-development-flow-smoke.bash");

describe("stateful development flow Git credentials", () => {
  it("exposes the reviewed DIM wrapper to host Git credential helpers", async () => {
    const smoke = await readFile(statefulSmoke, "utf8");
    const wrapperCreation = smoke.indexOf('chmod 0700 "$dim_bin"');
    const helperPath = smoke.indexOf('export PATH="$work_dir:$PATH"', wrapperCreation);
    const managedClone = smoke.indexOf("dim x git clone", wrapperCreation);

    expect(wrapperCreation).toBeGreaterThan(-1);
    expect(helperPath).toBeGreaterThan(wrapperCreation);
    expect(managedClone).toBeGreaterThan(helperPath);
  });
});
