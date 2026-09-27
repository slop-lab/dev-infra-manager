import { mkdir, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const socketPath = process.argv[2];
if (!socketPath?.startsWith("/")) {
  console.error("usage: node policy-server.mjs /absolute/path/policy.sock");
  process.exit(2);
}

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
await rm(socketPath, { force: true });

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    let input;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"allow":false,"reason":"request must be JSON"}\n');
      return;
    }
    response.setHeader("content-type", "application/json");
    if (input.requestedSubdomain === "docs") {
      response.end('{"allow":true,"subdomain":"shared-docs"}\n');
    } else {
      response.end('{"allow":false,"reason":"only the shared docs name is approved"}\n');
    }
  });
});

server.listen(socketPath, () => console.log(`route-policy-ready ${socketPath}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
