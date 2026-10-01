import http from "node:http";

const socketPath = process.env.DIM_QEMU_VERIFICATION_SOCKET ?? "/run/dim/qemu-verification/service.sock";
const [command = "run", ...arguments_] = process.argv.slice(2);
const inputs = [];
let verbose = false;
for (let index = 0; index < arguments_.length; index += 1) {
  if (arguments_[index] === "") continue;
  if (arguments_[index] === "--verbose") {
    verbose = true;
    continue;
  }
  if (arguments_[index] !== "--input" || !arguments_[index + 1]?.includes("=")) usage();
  const [name, ...pathParts] = arguments_[++index].split("=");
  inputs.push({ name, path: pathParts.join("=") });
}

if (command === "run" || command === "start" || command === "probe") {
  if (command === "probe" && (inputs.length > 0 || verbose)) usage();
  const mode = command === "probe" ? "probe" : "run";
  const response = await request("POST", "/v1/run", Buffer.from(JSON.stringify({ inputs, verbose, mode })));
  if (response.status !== 202) fail(response);
  if (command !== "start") {
    const events = await stream("/v1/events");
    const status = await request("GET", "/v1/status");
    if (events !== 0 || status.status !== 200 || JSON.parse(status.body).status !== "success") process.exitCode = 1;
  }
} else if (command === "status") {
  const response = await request("GET", "/v1/status");
  if (response.status !== 200) fail(response);
  process.stdout.write(response.body);
} else if (command === "follow") {
  process.exitCode = await stream("/v1/events");
} else if (command === "cancel") {
  const response = await request("DELETE", "/v1/run");
  if (response.status !== 202) fail(response);
} else usage();

function request(method, path, body = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path, headers: body.length ? {
      "content-type": "application/json", "content-length": body.length
    } : {} }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (body.length) request.write(body);
    request.end();
  });
}

function stream(path) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: "GET", path }, (response) => {
      if ((response.statusCode ?? 500) !== 200) {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => reject(new Error(Buffer.concat(chunks).toString("utf8").trim())));
        return;
      }
      response.pipe(process.stdout);
      response.on("end", () => resolve(0));
    });
    request.on("error", reject);
    request.end();
  });
}

function fail(response) {
  throw new Error(`QEMU verification request failed (${response.status}): ${response.body.trim()}`);
}

function usage() {
  throw new Error("usage: qemu-client.mjs run|start [--verbose] [--input NAME=/absolute/path ...] | probe | status | follow | cancel");
}
