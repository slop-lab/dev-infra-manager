import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";

export type StorageOwner = {
  release(): Promise<void>;
};

export async function acquireStorageOwner(storageRoot: string): Promise<StorageOwner> {
  const digest = createHash("sha256").update(resolve(storageRoot), "utf8").digest("hex");
  const server = createServer();
  server.listen({ path: `\0dim-native-git-${digest}` });
  try {
    await once(server, "listening");
  } catch (error) {
    if (isCode(error, "EADDRINUSE")) {
      throw new StorageOwnershipError("storage root already has an active server");
    }
    throw error;
  }
  return {
    async release() {
      await close(server);
    }
  };
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class StorageOwnershipError extends Error {
  readonly name = "StorageOwnershipError";
}
