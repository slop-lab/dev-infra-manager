import { describe, expect, it } from "vitest";
import { packageNameFromSpecifier } from "../src/install.js";

describe("@slop-lab/install-dim", () => {
  it("extracts registry package names without guessing path specs", () => {
    expect(packageNameFromSpecifier("@dev-infra-manager/plugin-github")).toBe("@dev-infra-manager/plugin-github");
    expect(packageNameFromSpecifier("@company/internal-git@1.2.3")).toBe("@company/internal-git");
    expect(packageNameFromSpecifier("dim-plugin-example@2")).toBe("dim-plugin-example");
    expect(packageNameFromSpecifier("./plugin.tgz")).toBeUndefined();
  });
});
