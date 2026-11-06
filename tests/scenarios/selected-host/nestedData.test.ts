import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { guestNestedData } from "./nestedData.js";

it("passes the challenge as the inner Node argument while outer write/read modes differ", () => {
  let retained: string | undefined;
  const id = "11111111-1111-4111-8111-111111111111", challenge = "owned-challenge";
  const fs = { realpathSync: (value: string) => value, mkdtempSync: () => "/private/nested", mkdirSync() {}, copyFileSync() {}, rmSync() {} };
  const execute = (command: string, args: readonly string[]): string | Buffer => {
    if (command === "ldd") return "";
    if (command === "docker" && args[0] === "run") {
      const code = args[args.indexOf("-e") + 1]; if (!code) throw new Error("inner Node code missing");
      runInNewContext(code, { process: { argv: ["node", args.at(-1)] }, require: () => ({
        writeFileSync: (_file: string, value: string) => { retained = value; }, readFileSync: () => retained
      }) });
    }
    return Buffer.from("");
  };
  for (const mode of ["write", "read"]) runInNewContext(guestNestedData, {
    process: { argv: ["node", mode, id, challenge], execPath: "/usr/bin/node", stdout: { write() {} } },
    Buffer, require: (name: string) => name === "node:fs" ? fs : name === "node:os" ? { tmpdir: () => "/tmp" }
      : name === "node:path" ? { join: (...parts: string[]) => parts.join("/"), dirname: () => "/private" } : { execFileSync: execute }
  });
  expect(retained).toBe(challenge);
});
