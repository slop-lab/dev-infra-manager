import { describe, expect, it } from "vitest";
import { startControlPlanePlugins } from "../../../../packages/control-plane/core/src/runtime.js";
import type { ControlPlanePlugin, PreparedControlPlanePlugin } from "../../../../packages/control-plane/core/src/plugin.js";

function plugin(name: string, configure: () => PreparedControlPlanePlugin): ControlPlanePlugin {
  return { apiVersion: 1, name, configure };
}
const signal = () => new AbortController().signal;
const compiler = { configurationPath: ".dim/ci/jobs.yml", compile: () => [] };
describe("standalone control-plane composition", () => {
  it("starts no implicit services and configures all plugins before starting providers and consumers", async () => {
    const events: string[] = [];
    const definition = (name: string, provides: boolean) => plugin(name, () => {
      events.push(`configure:${name}`);
      return { ...(provides ? { workflowCompiler: compiler } : { requiresWorkflowCompiler: true }), async start(context) {
        expect(context.workflowCompiler).toBe(compiler); events.push(`start:${name}`);
        return { async close() { events.push(`close:${name}`); } };
      } };
    });
    await (await startControlPlanePlugins([], signal())).close();
    expect(events).toEqual([]);
    const service = await startControlPlanePlugins([{ plugin: definition("git", false), config: {} }, { plugin: definition("grammar", true), config: {} }], signal());
    expect(events).toEqual(["configure:git", "configure:grammar", "start:grammar", "start:git"]);
    await service.close(); await service.close();
    expect(events.slice(-2)).toEqual(["close:git", "close:grammar"]);
  });
  it("rejects missing and duplicate compiler capabilities before any service starts", async () => {
    let starts = 0;
    const make = (name: string, provides: boolean) => plugin(name, () => ({
      ...(provides ? { workflowCompiler: compiler } : { requiresWorkflowCompiler: true }),
      async start() { starts++; return { async close() {} }; }
    }));
    await expect(startControlPlanePlugins([{ plugin: make("git", false), config: {} }], signal())).rejects.toThrow(/requires a workflow compiler/);
    await expect(startControlPlanePlugins([{ plugin: make("one", true), config: {} }, { plugin: make("two", true), config: {} }], signal())).rejects.toThrow(/only one/);
    expect(starts).toBe(0);
  });
  it("closes every prior service in reverse order after startup failure even when cleanup rejects", async () => {
    const closed: string[] = [];
    const make = (name: string) => plugin(name, () => ({ async start() {
      if (name === "three") throw new Error("startup failed");
      return { async close() { closed.push(name); if (name === "two") throw new Error("shutdown failed"); } };
    } }));
    await expect(startControlPlanePlugins(["one", "two", "three"].map((name) => ({ plugin: make(name), config: {} })), signal())).rejects.toThrow(/startup and cleanup failed/);
    expect(closed).toEqual(["two", "one"]);
  });
  it("closes a newly started service when cancellation races its startup completion", async () => {
    const abort = new AbortController(); let closed = 0;
    const definition = plugin("cancelled", () => ({ async start() { abort.abort(); return { async close() { closed++; } }; } }));
    await expect(startControlPlanePlugins([{ plugin: definition, config: {} }], abort.signal)).rejects.toThrow();
    expect(closed).toBe(1);
  });
});
