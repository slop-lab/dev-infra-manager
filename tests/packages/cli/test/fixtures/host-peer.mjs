// A real child process implementing the host transport envelope, without Docker.
if (process.argv[2] !== "__host") throw new Error("expected hidden host operation");
const request = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"));
if (request.operation === "fail") {
  process.stderr.write("source acquisition failed\n");
  process.exitCode = 2;
} else if (request.operation === "invalid") {
  process.stdout.write("not JSON");
} else if (request.operation === "exec") {
  process.stderr.write("exec stderr\n");
  process.stdin.pipe(process.stdout);
  process.stdin.on("end", () => { process.exitCode = request.input.exitCode; });
} else {
  process.stdout.write(JSON.stringify({ request }));
}
