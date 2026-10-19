import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { hostPlugin } from "../../../../packages/host/plugins/external-urls/src/index.js";

const execute = promisify(execFile);
const client = fileURLToPath(new URL("../../../../packages/host/plugins/external-urls/src/guest/dim-expose.mjs", import.meta.url));
const transport = fileURLToPath(new URL("../../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));

it("the plugin-owned expose CLI uses the common scoped transport and rejects selectors before making requests", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-expose-client-"));
  const calls: { url: string; body: unknown; authorization: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({ url: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")), authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" }).end('{"urls":[]}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
    const bin = path.join(home, ".local/bin"); await mkdir(bin, { recursive: true });
    await cp(transport, path.join(bin, "dim-workspace"));
    const configuration = path.join(home, ".config/dim/workspace.json"); await mkdir(path.dirname(configuration), { recursive: true });
    await writeFile(configuration, JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}`, workspaceId: "fixed", token: "workspace-only" }), { mode: 0o600 });
    const run = (...args: string[]) => execute(process.execPath, [client, ...args], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    await run("--name", "web", "--port", "3000", "--ingress", "local"); await run("list");
    expect(calls).toEqual([
      { url: "/v1/plugins/external-urls/expose", body: { name: "web", ingress: "local", port: 3000 }, authorization: "Bearer workspace-only" },
      { url: "/v1/plugins/external-urls/urls", body: {}, authorization: "Bearer workspace-only" }
    ]);
    await expect(run("--name", "web", "--port", "3000", "--ingress", "local", "--workspace", "foreign")).rejects.toThrow();
    await expect(run("--name", "web", "--port", "0", "--ingress", "local")).rejects.toThrow();
    expect(calls).toHaveLength(2);
    expect(await readFile(configuration, "utf8")).toContain("workspace-only");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});

it("declares domain operations and the delivered command instead of adding URL methods to the kernel", () => {
  expect(hostPlugin.guest?.commands?.map(({ name }) => name)).toEqual(["dim-expose"]);
  expect(hostPlugin.guest?.operations?.map(({ name }) => name)).toEqual(["expose", "urls"]);
});
