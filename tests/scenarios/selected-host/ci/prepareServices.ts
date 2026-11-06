import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const setup = process.argv[2];
if (!setup?.startsWith("/")) throw new Error("absolute fixture operator directory required");
const directory = join(setup, "practical"); await mkdir(directory, { mode: 0o700 });
for (const name of ["issuer", "reader", "ingress"]) await writeFile(join(directory, `${name}.key`), randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
await writeFile(join(directory, "reader.json"), JSON.stringify({ schemaVersion: 1, endpoint: "http://127.0.0.1:18318", actorId: "practical-reader", keyFile: join(directory, "reader.key") }), { mode: 0o600, flag: "wx" });
console.log("Prepared new test-owned scoped authorities; no operator/provider account credentials imported");
