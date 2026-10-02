#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { createNativeGitServer, parseNativeGitServiceConfig } from "./index.js";

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (process.argv.length !== 3 || configPath === undefined) {
    process.stderr.write("usage: dim-native-git /absolute/path/to/config.json\n");
    process.exitCode = 2;
    return;
  }
  const stat = await lstat(configPath);
  const uid = process.getuid?.();
  if (uid === undefined || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new NativeGitConfigFileError("native Git configuration must be a caller-owned mode-0600 regular file");
  }
  const config = parseNativeGitServiceConfig(JSON.parse(await readFile(configPath, "utf8")));
  const service = createNativeGitServer(config);
  const baseUrl = await service.listen();
  process.stdout.write(`${baseUrl}\n`);
  const stop = async (): Promise<void> => {
    await service.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

class NativeGitConfigFileError extends Error {
  readonly name = "NativeGitConfigFileError";
}
