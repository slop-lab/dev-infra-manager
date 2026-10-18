import { readFile } from "node:fs/promises";
import net from "node:net";

const listenPort = Number(process.argv[2]);
const configPath = process.argv[3];
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535 || !configPath) {
  throw new Error("usage: route-relay.mjs LISTEN_PORT CONFIG_PATH");
}

net.createServer(async (client) => {
  try {
    const target = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof target.host !== "string" || !Number.isInteger(target.port)) {
      throw new Error("invalid route relay target");
    }
    const upstream = net.connect(target.port, target.host);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.pipe(upstream).pipe(client);
  } catch {
    client.destroy();
  }
}).listen(listenPort, "0.0.0.0");
