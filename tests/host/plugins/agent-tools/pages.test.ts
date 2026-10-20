import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { stagePages } from "../../../../tools/opencode-web/stage.ts";

it("stages only the pinned UI version while retaining other versions and unrelated Pages content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-pages-stage-"));
  const source = path.join(root, "build"), target = path.join(root, "pages");
  try {
    await mkdir(source); await mkdir(path.join(target, "opencode-web/v/1.0.0"), { recursive: true });
    await writeFile(path.join(target, "documentation.html"), "preserved documentation");
    await writeFile(path.join(target, "opencode-web/v/1.0.0/index.html"), "preserved older UI");
    await writeFile(path.join(target, "opencode-web/versions.json"), JSON.stringify({ default: "1.0.0", versions: ["1.0.0"] }));
    await writeFile(path.join(source, "index.html"), "new UI");
    const metadata = { version: "1.18.31", commit: "014614d35b397775e5d397a490fc72368c894ec2", pagesBase: "/dev-infra-manager/opencode-web/v/1.18.31/", router: "hash", implicitServer: false };
    await writeFile(path.join(source, "build-info.json"), JSON.stringify(metadata));
    const staged = await stagePages(source, target);
    expect(await readFile(path.join(staged, "index.html"), "utf8")).toBe("new UI");
    expect(await readFile(path.join(target, "documentation.html"), "utf8")).toBe("preserved documentation");
    expect(await readFile(path.join(target, "opencode-web/v/1.0.0/index.html"), "utf8")).toBe("preserved older UI");
    expect(JSON.parse(await readFile(path.join(target, "opencode-web/versions.json"), "utf8")))
      .toEqual({ default: "1.18.31", versions: ["1.18.31", "1.0.0"] });
    await writeFile(path.join(source, "build-info.json"), JSON.stringify({ ...metadata, commit: "unreviewed" }));
    await expect(stagePages(source, target)).rejects.toThrow(/pinned Pages client/);
    expect(await readFile(path.join(staged, "index.html"), "utf8")).toBe("new UI");
  } finally { await rm(root, { recursive: true, force: true }); }
});
