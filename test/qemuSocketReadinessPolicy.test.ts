import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("canonical QEMU socket readiness", () => {
  it("waits for both the Unix socket and its client-usable mode", async () => {
    const setup = await readFile(resolve(workspaceRoot, "project/.dim/setup.sh"), "utf8");
    const readiness = setup.slice(
      setup.indexOf("for _ in $(seq 1 50); do", setup.indexOf("DIM_QEMU_SERVICE_SOCKET")),
      setup.indexOf("else", setup.indexOf("DIM_QEMU_SERVICE_SOCKET"))
    );

    expect(readiness).toContain('test -S "$qemu_service_dir/service.sock"');
    expect(readiness).toContain('stat -c %a "$qemu_service_dir/service.sock"');
    expect(readiness.match(/= 666/g)).toHaveLength(2);
  });
});
