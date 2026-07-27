import http from "node:http";
import { execFile } from "node:child_process";

// Neither the service name nor Docker arguments come from the caller.
const service = "example-secret-service";
const actions = new Set(["start", "stop", "restart"]);

function docker(args) {
  return new Promise((resolve) => {
    execFile("docker", args, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: stdout.trim(),
        error: stderr.trim() || error?.message,
      });
    });
  });
}

const server = http.createServer(async (request, response) => {
  const action = request.url?.slice(1);
  let result;

  if (request.method === "POST" && actions.has(action)) {
    result = await docker([action, service]);
  } else if (request.method === "GET" && action === "status") {
    result = await docker([
      "inspect",
      "--format",
      "{{.State.Status}}",
      service,
    ]);
  } else {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "unknown operation" }));
    return;
  }

  response.writeHead(result.ok ? 200 : 409, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(result));
});

server.listen(7100, "0.0.0.0", () => {
  console.log(`controlling lifecycle for ${service}`);
});
