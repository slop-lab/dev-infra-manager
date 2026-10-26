import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writeExecutables } from "./environment.js";

it("pins private controller sockets even when the caller selected an unrelated live controller", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dwl-env-"));
  vi.stubEnv("DIM_CONTROLLER_SOCKET", "/unrelated/live-controller.sock");
  vi.stubEnv("DIM_ADMIN_CONTROLLER_SOCKET", "/unrelated/live-admin.sock");
  try {
    const { env } = await writeExecutables(root);
    expect(env.DIM_CONTROLLER_SOCKET?.startsWith(root + path.sep)).toBe(true);
    expect(env.DIM_ADMIN_CONTROLLER_SOCKET?.startsWith(root + path.sep)).toBe(true);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
