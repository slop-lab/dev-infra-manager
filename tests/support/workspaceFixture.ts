import { createHash } from "node:crypto";
import { type WorkspaceRecord } from "@slop-lab/dim-core/workspace";

export function workspaceRecord(name = "work-a", overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 32);
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
  return { schemaVersion: 10, id, name, source: { url: "https://example.invalid/app.git", ref: "refs/heads/main", commit: "a".repeat(40) },
    runtime: "container", image: "test-workspace", resources: { cpuCount: "2", memory: "4g", pidsLimit: "2048" },
    git: { name: "Agent", email: "agent@example.invalid" }, initialized: true, phase: "running",
    createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z", ...overrides };
}
