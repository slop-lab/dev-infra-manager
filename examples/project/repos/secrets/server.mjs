import http from "node:http";

const port = Number(process.env.PORT ?? "7099");
const secret = process.env.EXAMPLE_SECRET;
if (!secret) {
  console.error("EXAMPLE_SECRET is required");
  process.exit(1);
}

// The secret is used, never returned: this endpoint only proves it was
// configured, exactly what a real health check needs and no more.
const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, secretConfigured: Boolean(secret) }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`example secret-bearing service listening on ${port}`);
});
