import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const [sourceSocket, developmentSocket, proxySocket, externalPortText, beforeFile, afterFile, keyFile, certFile] = process.argv.slice(2);
const externalPort = Number.parseInt(externalPortText, 10);
const urls = [];
for (const socket of [sourceSocket, developmentSocket]) {
  try {
    fs.unlinkSync(socket);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api") {
    json(response, 200, { routes: [{ path: "/api/urls", discovery: { ingresses: [{ name: "https-ts", description: "fixture", scheme: "https" }] } }] });
    return;
  }
  if (request.method === "GET" && request.url === "/api/urls") {
    json(response, 200, { urls });
    return;
  }
  if (request.method === "POST" && request.url === "/api/urls") {
    const body = JSON.parse((await readBody(request)).toString("utf8"));
    fs.appendFileSync(afterFile, `${JSON.stringify(body)}\n`);
    const index = urls.length + 1;
    const created = {
      id: `url-${index}`,
      ingress: body.ingress,
      url: `https://service-${index}.example.test:${externalPort}`,
      target: body.target
    };
    urls.push(created);
    json(response, 201, { urls: [created] });
    return;
  }
  response.writeHead(404).end();
}).listen(sourceSocket);

http.createServer(async (request, response) => {
  const body = await readBody(request);
  if (request.method === "POST") fs.appendFileSync(beforeFile, `${body.toString("utf8")}\n`);
  const upstream = http.request({
    socketPath: proxySocket,
    method: request.method,
    path: request.url,
    headers: request.headers
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => response.writeHead(502).end());
  upstream.end(body);
}).listen(developmentSocket);

const tls = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (request, response) => {
  const upstream = http.request({
    host: "127.0.0.1",
    port: 31887,
    method: request.method,
    path: request.url,
    headers: request.headers
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => response.writeHead(502).end());
  request.pipe(upstream);
});

tls.on("upgrade", (request, socket, head) => {
  const upstream = http.request({
    host: "127.0.0.1",
    port: 31887,
    method: request.method,
    path: request.url,
    headers: request.headers
  });
  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const headers = [];
    for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
      headers.push(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`);
    }
    socket.write(`HTTP/1.1 ${upstreamResponse.statusCode} Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on("error", () => socket.end());
  upstream.end();
});
tls.listen(externalPort, "127.0.0.1");
