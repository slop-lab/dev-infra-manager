import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { sendJson } from "./native-bundle-http.js";

type NativeBundleHttpServerInput = {
  readonly closed: () => boolean;
  readonly handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  readonly onListening: () => void;
};

export function createNativeBundleHttpServer(input: NativeBundleHttpServerInput): Server {
  const server = createServer((request, response) => {
    if (input.closed()) {
      sendJson(response, 503, { error: "native Git bundle server is closed" });
      return;
    }
    void input.handle(request, response).catch(() => {
      if (input.closed() || response.headersSent || response.writableEnded) response.destroy();
      else sendJson(response, 500, { error: "internal server error" });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.on("listening", () => {
    if (input.closed()) {
      server.closeAllConnections();
      server.close();
      return;
    }
    input.onListening();
  });
  return server;
}
