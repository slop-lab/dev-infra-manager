import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type RequestListener } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type NativeTlsFixture = {
  readonly ca: Buffer;
  readonly origin: string;
  readonly wrongHostnameOrigin: string;
  readonly server: Server;
  close(): Promise<void>;
};

export async function nativeTlsServer(listener: RequestListener): Promise<NativeTlsFixture> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-tls-"));
  const caKey = join(root, "ca.key");
  const caCertificate = join(root, "ca.pem");
  const serverKey = join(root, "server.key");
  const request = join(root, "server.csr");
  const serverCertificate = join(root, "server.pem");
  const extensions = join(root, "server.ext");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", caKey, "-out", caCertificate, "-subj", "/CN=DIM Native Test CA",
    "-addext", "basicConstraints=critical,CA:TRUE"]);
  await run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey,
    "-out", request, "-subj", "/CN=localhost"]);
  await writeFile(extensions, [
    "subjectAltName=DNS:localhost",
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth"
  ].join("\n"));
  await run("openssl", ["x509", "-req", "-in", request, "-CA", caCertificate, "-CAkey", caKey,
    "-CAcreateserial", "-days", "1", "-out", serverCertificate, "-extfile", extensions]);
  const server = createServer({ key: await readFile(serverKey), cert: await readFile(serverCertificate) }, listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("TLS fixture did not bind TCP");
  return {
    ca: await readFile(caCertificate),
    origin: `https://localhost:${address.port}`,
    wrongHostnameOrigin: `https://127.0.0.1:${address.port}`,
    server,
    async close() {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      }
      await rm(root, { recursive: true, force: true });
    }
  };
}

export async function nativeTlsProxy(targetOrigin: string): Promise<NativeTlsFixture> {
  return nativeTlsServer((incoming, outgoing) => {
    const target = new URL(incoming.url ?? "/", targetOrigin);
    const upstream = httpRequest(target, { method: incoming.method, headers: incoming.headers }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.once("error", (error) => outgoing.destroy(error));
    incoming.pipe(upstream);
  });
}
