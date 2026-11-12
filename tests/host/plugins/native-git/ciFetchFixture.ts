const endpoint = process.env.DIM_TEST_CI_ENDPOINT;
if (!endpoint) throw new Error("missing test-only CI endpoint");
const target = new URL(endpoint);
if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.pathname !== "/"
  || target.username || target.password || target.search || target.hash) throw new Error("invalid test-only loopback CI endpoint");
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (typeof input !== "string" || !input.startsWith("http://127.0.0.1:19420/")) throw new Error("unexpected fixture request");
  return original(new URL(input.slice("http://127.0.0.1:19420".length), target), init);
};
