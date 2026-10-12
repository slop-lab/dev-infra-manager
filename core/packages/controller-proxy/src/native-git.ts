import { createServer, request as httpRequest, type Server } from "node:http";

export type NativeGitProxyOptions = {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly sourceSocket: string;
  readonly token: string;
};

export function createNativeGitProxy(options: NativeGitProxyOptions): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://dim-native-git-proxy");
    if (!allowed(request.method, url, request.headers["content-type"])) {
      response.writeHead(404).end();
      return;
    }
    const upstream = httpRequest({
      socketPath: options.sourceSocket,
      method: request.method,
      path: `/api/native-git${url.pathname}${url.search}`,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(request.headers["content-type"] === undefined ? {} : { "content-type": request.headers["content-type"] }),
        ...(request.headers["git-protocol"] === undefined ? {} : { "git-protocol": request.headers["git-protocol"] })
      }
    }, (upstreamResponse) => {
      if ((upstreamResponse.statusCode ?? 500) >= 300 && (upstreamResponse.statusCode ?? 500) < 400) {
        upstreamResponse.destroy();
        response.writeHead(502).end();
        return;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, {
        ...(upstreamResponse.headers["content-type"] === undefined ? {} : { "content-type": upstreamResponse.headers["content-type"] }),
        ...(upstreamResponse.headers["cache-control"] === undefined ? {} : { "cache-control": upstreamResponse.headers["cache-control"] })
      });
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
}

export async function listenNativeGitProxy(server: Server, options: NativeGitProxyOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function allowed(method: string | undefined, url: URL, contentType: string | undefined): boolean {
  const match = /^\/v1\/projects\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/repositories\/root\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/
    .exec(url.pathname);
  const endpoint = match?.[1];
  if (method === "GET" && endpoint === "info/refs") {
    return url.searchParams.size === 1 && (url.searchParams.get("service") === "git-upload-pack"
      || url.searchParams.get("service") === "git-receive-pack");
  }
  if (method !== "POST" || url.search !== "") return false;
  return (endpoint === "git-upload-pack" && contentType === "application/x-git-upload-pack-request")
    || (endpoint === "git-receive-pack" && contentType === "application/x-git-receive-pack-request");
}
