import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
if (process.argv.includes("-h")) {
  console.log("CLIProxyAPI Version: 8.0.33, Commit: fixture");
} else {
  const path = process.argv[process.argv.indexOf("-config") + 1]!;
  const config = JSON.parse(await readFile(path, "utf8")) as { server: { host: string; port: number }; oauth: { "auth-dir": string }; access: { "api-keys": string[] } };
  if (process.argv.includes("-codex-device-login")) {
    console.log("Open https://auth.openai.com/codex/device and enter ABCD-12345");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await writeFile(join(config.oauth["auth-dir"], "fixture-account.json"), JSON.stringify({ type: "codex", refresh_token: "fixture-private-refresh" }), { mode: 0o600 });
  } else {
    const server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${config.access["api-keys"][0]}`) { response.writeHead(401).end(); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":[]}');
    });
    server.listen(config.server.port, config.server.host);
    process.once("SIGTERM", () => server.close());
  }
}
