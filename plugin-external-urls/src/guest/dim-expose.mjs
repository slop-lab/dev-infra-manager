#!/usr/bin/env node
// @ts-check
import { spawnSync } from "node:child_process";

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) {
    console.log("Usage: dim-expose --name NAME --port PORT --ingress NAME\n       dim-expose list");
  } else {
    let operation;
    /** @type {Record<string, unknown>} */
    let input = {};
    if (args.length === 1 && args[0] === "list") operation = "urls";
    else {
      /** @type {Record<string, string>} */
      const flags = {};
      for (let index = 0; index < args.length; index += 2) {
        const key = args[index], value = args[index + 1];
        if (!key || !["--name", "--port", "--ingress"].includes(key) || value === undefined || flags[key] !== undefined) throw new Error("expected --name NAME --port PORT --ingress NAME");
        flags[key] = value;
      }
      const port = Number(flags["--port"]), name = flags["--name"], ingress = flags["--ingress"];
      if (!name || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(name) || !ingress || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(ingress)
        || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("expected a service name, ingress and loopback port");
      operation = "expose"; input = { name, ingress, port };
    }
    const result = spawnSync("dim-workspace", ["plugin", "external-urls", operation, JSON.stringify(input)], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(`dim-expose: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
