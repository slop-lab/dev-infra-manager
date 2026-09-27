export function parseInputs(value, path) {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("inputs must be an array of at most 16 entries");
  }
  const names = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("each input must be an object");
    }
    const { name, path: requested } = entry;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
      throw new Error(`invalid input name '${String(name)}'`);
    }
    if (names.has(name)) throw new Error(`duplicate input name '${name}'`);
    if (typeof requested !== "string" || !path.isAbsolute(requested)) {
      throw new Error(`input '${name}' path must be absolute`);
    }
    names.add(name);
    return { name, path: requested };
  });
}

export async function readJson(request, signal) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > 65_536) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  if (size === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  return value;
}

export function sendJson(response, status, value) {
  if (response.headersSent) return response.end();
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
