import { createServer } from "node:http";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("hello from a single-repository DIM workspace\n");
});

server.listen(3000, "0.0.0.0");
