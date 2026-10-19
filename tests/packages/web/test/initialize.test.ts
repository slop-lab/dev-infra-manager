import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createReviewerWebServerFromConfigFile } from "../../../../core/packages/web/src/server.js";
import { humanReviewer, generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { installedReviewerFixture, availablePort } from "./webHarness.js";

it("initializes a private reviewer configuration from a live generated connection and logs in", async () => {
  const native = await installedReviewerFixture();
  const root = await mkdtemp(join(tmpdir(), "dim-web-init-"));
  const connection = join(root, "reviewer.json"), output = join(root, "web.json");
  const config = { schemaVersion: 1, serviceId: "native-main", baseUrl: native.baseUrl(), generationId, ...humanReviewer };
  const cli = fileURLToPath(new URL("../../../../core/packages/web/src/cli.ts", import.meta.url));
  const run = (path = output) => promisify(execFile)(process.execPath, ["--import", "tsx", cli, "init", connection,
    "--project", "project-a", "--output", path, "--port", String(port)]);
  const port = await availablePort();
  try {
    await writeFile(connection, JSON.stringify(config), { mode: 0o600 });
    const { stdout } = await run();
    const password = /Browser password: (\S+)/.exec(stdout)?.[1];
    expect(password).toBeTruthy(); expect(stdout).not.toContain(humanReviewer.password);
    const before = await readFile(output, "utf8");
    expect(before).not.toContain(password!); expect((await stat(output)).mode & 0o777).toBe(0o600);
    const service = await createReviewerWebServerFromConfigFile(output);
    try {
      const origin = await service.listen();
      const response = await fetch(`${origin}/v1/session`, { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json"
      }, body: JSON.stringify({ username: "reviewer", password }) });
      expect(response.status).toBe(201);
    } finally { await service.close(); }
    await expect(run()).rejects.toThrow(); expect(await readFile(output, "utf8")).toBe(before);
    await writeFile(connection, JSON.stringify({ ...config, generationId: "b".repeat(64) }));
    await expect(run(join(root, "stale.json"))).rejects.toThrow();
    await expect(stat(join(root, "stale.json"))).rejects.toThrow();
    await chmod(connection, 0o644);
    await expect(run(join(root, "public.json"))).rejects.toThrow();
  } finally { await native.close(); await rm(root, { recursive: true, force: true }); }
});

it("initializes an ordinary host operations account through the public CLI without a native Git connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-web-operations-init-"));
  try {
    const settings = join(root, "operations.json"), output = join(root, "web.json");
    await writeFile(settings, JSON.stringify({ hosts: [{ id: "devbox", selector: "saved-host", executable: "/trusted/dim" }] }), { mode: 0o600 });
    const cli = fileURLToPath(new URL("../../../../core/packages/web/src/cli.ts", import.meta.url));
    const args = ["--import", "tsx", cli, "init-operations", settings, "--output", output];
    const { stdout } = await promisify(execFile)(process.execPath, args);
    const password = /Browser password: (\S+)/.exec(stdout)?.[1]; expect(password).toBeTruthy();
    const bytes = await readFile(output, "utf8"); expect(bytes).not.toContain(password!);
    const config: unknown = JSON.parse(bytes);
    expect(config).toMatchObject({ accounts: [{ username: "operator", roles: ["read", "operator"] }], operations: { hosts: [{ id: "devbox" }] } });
    expect(config).not.toHaveProperty("nativeGit"); expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(promisify(execFile)(process.execPath, args)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
