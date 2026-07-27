import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const port = Number.parseInt(process.env.CF_MOCK_PORT ?? "", 10);
const zoneFile = process.env.CF_MOCK_ZONE_FILE;
const zoneName = normalize(process.env.CF_MOCK_ZONE ?? "example.test");
const zoneId = "local-zone";
const records = new Map();
let nextRecord = 1;
let serial = Math.floor(Date.now() / 1000);

if (!Number.isInteger(port) || port < 1 || port > 65535 || !zoneFile) {
  throw new Error("CF_MOCK_PORT and CF_MOCK_ZONE_FILE are required");
}

await persistZone();

createServer(async (request, response) => {
  try {
    if (request.headers.authorization !== "Bearer smoke-token") {
      return reply(response, 403, undefined, [{ message: "invalid test token" }]);
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/client/v4/zones") {
      const result = normalize(url.searchParams.get("name") ?? "") === zoneName
        ? [{ id: zoneId, name: zoneName }]
        : [];
      return reply(response, 200, result);
    }
    if (
      request.method === "GET"
      && url.pathname === `/client/v4/zones/${zoneId}/dns_records`
    ) {
      const name = normalize(url.searchParams.get("name") ?? "");
      return reply(response, 200, [...records.values()].filter((record) => record.name === name));
    }
    if (
      request.method === "POST"
      && url.pathname === `/client/v4/zones/${zoneId}/dns_records`
    ) {
      const record = validateRecord(await readBody(request), `record-${nextRecord++}`);
      records.set(record.id, record);
      await persistZone();
      return reply(response, 200, record);
    }
    const recordMatch = url.pathname.match(
      new RegExp(`^/client/v4/zones/${zoneId}/dns_records/([^/]+)$`)
    );
    if (recordMatch && request.method === "PUT") {
      const id = recordMatch[1];
      if (!records.has(id)) return reply(response, 404, undefined, [{ message: "record not found" }]);
      const record = validateRecord(await readBody(request), id);
      records.set(id, record);
      await persistZone();
      return reply(response, 200, record);
    }
    if (recordMatch && request.method === "DELETE") {
      records.delete(recordMatch[1]);
      await persistZone();
      return reply(response, 200, {});
    }
    return reply(response, 404, undefined, [{ message: "unsupported mock endpoint" }]);
  } catch (error) {
    return reply(response, 400, undefined, [{ message: String(error) }]);
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`cloudflare-dns-mock-ready:${port}`);
});

function validateRecord(input, id) {
  if (!["A", "AAAA", "CNAME"].includes(input.type)) throw new Error("unsupported record type");
  const name = normalize(input.name);
  if (!name.endsWith(`.${zoneName}`)) throw new Error("record is outside the mock zone");
  return {
    id,
    name,
    type: input.type,
    content: String(input.content),
    proxied: Boolean(input.proxied)
  };
}

async function persistZone() {
  serial += 1;
  const lines = [
    `$ORIGIN ${zoneName}.`,
    `$TTL 1`,
    `@ IN SOA ns.${zoneName}. hostmaster.${zoneName}. ${serial} 1 1 1 1`,
    `@ IN NS ns.${zoneName}.`,
    `ns IN A 127.0.0.1`
  ];
  for (const record of records.values()) {
    const owner = record.name.slice(0, -(zoneName.length + 1));
    const content = record.type === "CNAME" ? `${normalize(record.content)}.` : record.content;
    lines.push(`${owner} 1 IN ${record.type} ${content}`);
  }
  await writeFile(zoneFile, `${lines.join("\n")}\n`, { mode: 0o644 });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalize(value) {
  return value.toLowerCase().replace(/^\.+|\.+$/g, "");
}

function reply(response, status, result, errors = []) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ success: status < 400, errors, result }));
}
