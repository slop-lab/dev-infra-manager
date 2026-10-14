import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createEventFollower } from "../../.dim/qemu-event-followers.mjs";

class BackpressuredResponse extends EventEmitter {
  readonly writes: Buffer[] = [];
  endCalls = 0;

  destroy(): void {
    this.emit("close");
  }

  end(): void {
    this.endCalls += 1;
  }

  write(chunk: Buffer | string): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return false;
  }
}

describe("QEMU event follower", () => {
  it("waits for queued output to drain before ending once", () => {
    // Given
    const response = new BackpressuredResponse();
    const follower = createEventFollower(response, () => undefined);
    follower.write(Buffer.from("accepted"));
    follower.write(Buffer.from("queued"));

    // When
    follower.end();

    // Then
    expect.soft(response.writes.map((chunk) => chunk.toString("utf8"))).toEqual(["accepted"]);
    expect.soft(response.endCalls).toBe(0);
    response.emit("drain");
    expect.soft(response.writes.map((chunk) => chunk.toString("utf8"))).toEqual(["accepted", "queued"]);
    expect.soft(response.endCalls).toBe(0);
    response.emit("drain");
    expect(response.endCalls).toBe(1);
  });
});
