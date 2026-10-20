import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withServiceImageContext } from "../../../scripts/packages/build-service-image.ts";

it("gives Docker only the selected image inputs and built packages, then removes its context", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-image-inputs-test-"));
  let context = "";
  try {
    const imageDirectory = join(root, "image"), output = join(root, "dist");
    await mkdir(imageDirectory); await mkdir(output);
    for (const file of ["Dockerfile", "package.json", "package-lock.json", "dim-service"]) await writeFile(join(imageDirectory, file), file);
    await writeFile(join(imageDirectory, ".env"), "not a build input");
    await writeFile(join(root, "operator-secret"), "not a build input");
    await writeFile(join(output, "package.json"), JSON.stringify({ name: "@slop-lab/dim-test-service" }));
    await writeFile(join(output, "index.js"), "export {};\n");
    await expect(withServiceImageContext({ imageDirectory, packageDirectories: [output] }, async (directory) => {
      context = directory;
      expect((await readdir(directory)).sort()).toEqual(["Dockerfile", "dim-service", "modules", "package-lock.json", "package.json"]);
      expect(await readdir(join(directory, "modules/@slop-lab"))).toEqual(["dim-test-service"]);
      expect(await readFile(join(directory, "modules/@slop-lab/dim-test-service/index.js"), "utf8")).toBe("export {};\n");
      throw new Error("build failed");
    })).rejects.toThrow("build failed");
    await expect(stat(context)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "operator-secret"), "utf8")).toBe("not a build input");
  } finally { await rm(root, { recursive: true, force: true }); }
});
