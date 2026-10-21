import { expect, it } from "vitest";
import { executionServiceConfigSchema } from "../../../../packages/control-plane/plugins/execution-scheduler/src/config.js";
import { controlPlanePlugin } from "../../../../packages/control-plane/plugins/execution-scheduler/src/index.js";

const credential = (username: string, value: number) => ({ username, password: Buffer.alloc(32, value).toString("base64url") });
const taskOnly = () => ({ schemaVersion: 1, claimLeaseMilliseconds: 30_000,
  credentials: { operator: credential("operator", 1), tasks: credential("tasks", 2) },
  workers: [{ id: "worker", token: Buffer.alloc(32, 3).toString("base64url"),
    slots: [{ id: "review", taskType: "review-tracing-node", handlerRevision: "a".repeat(64) }] }] });

it("configures general tasks without native Git authority or unused CI credentials", () => {
  const config = executionServiceConfigSchema.parse(taskOnly());
  expect(config.nativeGit).toBeUndefined();
  expect(config.credentials.webhook).toBeUndefined();
  expect(config.credentials.query).toBeUndefined();
  expect(controlPlanePlugin.name).toBe("execution-scheduler");
});

it("requires an independent issuer for task slots and rejects duplicate slot ownership", () => {
  const config = taskOnly();
  expect(executionServiceConfigSchema.safeParse({ ...config, credentials: { operator: config.credentials.operator } }).success).toBe(false);
  expect(executionServiceConfigSchema.safeParse({ ...config,
    workers: [{ ...config.workers[0], slots: [config.workers[0]!.slots[0], config.workers[0]!.slots[0]] }] }).success).toBe(false);
});
