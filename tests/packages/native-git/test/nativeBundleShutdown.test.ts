import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createNativeBundleShutdown } from "../../../../core/packages/native-git/src/native-bundle-shutdown.js";

describe("native bundle shutdown", () => {
  it("releases the owned store and closes the listener after a drain failure", async () => {
    // Given
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const events: string[] = [];
    const close = createNativeBundleShutdown({ server,
      state: { stateFormat: 8, database: "unused", owner: { async release() { events.push("released"); } } },
      eventDispatcher: { start() {}, wake() {}, healthy() { return true; },
        async close() { events.push("dispatcher-closed"); } },
      stopAdmission() { events.push("admission-stopped"); },
      async drainOperations() { throw new Error("drain failed"); }
    });

    // When
    try {
      await expect(close()).rejects.toThrow("drain failed");

      // Then
      expect(events).toEqual(["admission-stopped", "dispatcher-closed", "released"]);
      expect(server.listening).toBe(false);
    } finally {
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
    }
  });
});
