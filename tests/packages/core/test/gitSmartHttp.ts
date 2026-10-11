import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";

export type GitSmartHttp = {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
};

export async function startGitSmartHttp(projectRoot: string): Promise<GitSmartHttp> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        CONTENT_LENGTH: request.headers["content-length"] ?? "",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_PROJECT_ROOT: projectRoot,
        PATH_INFO: requestUrl.pathname,
        QUERY_STRING: requestUrl.search.slice(1),
        REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
        REQUEST_METHOD: request.method ?? "GET"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    request.pipe(child.stdin);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.on("error", () => response.destroy());
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        response.writeHead(500).end();
        return;
      }
      const output = Buffer.concat(stdout);
      const separator = output.indexOf("\r\n\r\n");
      if (separator < 0) {
        response.writeHead(500).end();
        return;
      }
      const headers = output.subarray(0, separator).toString("utf8").split("\r\n");
      let status = 200;
      for (const header of headers) {
        const split = header.indexOf(":");
        if (split < 1) continue;
        const name = header.slice(0, split);
        const value = header.slice(split + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else response.setHeader(name, value);
      }
      response.writeHead(status).end(output.subarray(separator + 4));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP listener");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    }
  };
}
