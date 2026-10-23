import { expect, it } from "vitest";
import { createHostRequest, decodeHostRequest, encodeHostRequest, parseCapabilities } from "@slop-lab/dim-contracts-cli-host";

it("preserves arbitrary future command arguments independently of a host release", () => {
  const request = createHostRequest("command", { args: ["future-command", "--future-option", "", "--", "$(literal)"] });
  expect(decodeHostRequest(encodeHostRequest(request))).toEqual(request);
  expect(parseCapabilities({ protocol: "dim.cli-host", versions: [7, 1], hostRelease: "unrelated" }).versions).toContain(1);
});
it("rejects an unknown version before dispatching even malformed command input", () => {
  const encoded = Buffer.from(JSON.stringify({ protocol: "dim.cli-host", version: 2, operation: "command", input: "private payload" })).toString("base64url");
  expect(() => decodeHostRequest(encoded)).toThrow("Unsupported DIM CLI/host protocol version");
  expect(() => decodeHostRequest(Buffer.from('{"private":"secret').toString("base64url"))).toThrow("Invalid DIM CLI/host request JSON");
});
it("requires a pinned workspace identity on every TCP stream", () => {
  expect(() => decodeHostRequest(Buffer.from(JSON.stringify({ protocol: "dim.cli-host", version: 1, operation: "workspace.connect", input: { name: "reused", port: 3000 } })).toString("base64url"))).toThrow("Invalid DIM CLI/host operation");
});
