import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError } from "../errors.js";
import type { RunOptions } from "../types.js";
import { workspaceImageReference } from "../workspaceImageReference.js";
import type { AcquiredWorkspaceSource, WorkspaceRecord, WorkspaceResources, WorkspaceSource, WorkspaceView } from "./models.js";
import { WorkspaceStore, validateResources, workspaceName } from "./store.js";
import { validateWorkspacePort } from "./portBridge.js";

export interface WorkspaceRuntime {
  inspect(record: WorkspaceRecord): Promise<{ running: boolean } | undefined>;
  create(record: WorkspaceRecord): Promise<void>;
  start(record: WorkspaceRecord): Promise<void>;
  stop(record: WorkspaceRecord): Promise<void>;
  remove(record: WorkspaceRecord, options: { keepData: boolean }): Promise<void>;
  updateResources(record: WorkspaceRecord, resources: WorkspaceResources): Promise<{ recreated: boolean }>;
  seed(record: WorkspaceRecord, directory: string): Promise<void>;
  exec(record: WorkspaceRecord, command: string[], options?: RunOptions): Promise<number>;
  connect(record: WorkspaceRecord, port: number, options?: WorkspaceConnectOptions): Promise<number>;
}

export interface WorkspaceConnectOptions extends Pick<RunOptions, "stdin" | "stdout" | "stderr" | "signal"> {
  /** A long-lived forward must not follow a reused workspace name. */
  workspaceId?: string;
}

export interface CreateWorkspaceInput {
  name: string;
  source: WorkspaceSource;
  image?: string;
  resources?: Partial<WorkspaceResources>;
  git?: { name: string; email: string };
}

export type AcquireSource = (input: { source: WorkspaceSource; destination: string }) => Promise<AcquiredWorkspaceSource>;

/** One host-local application path, shared by local, SSH and future UI callers. */
export class WorkspaceService {
  constructor(readonly store: WorkspaceStore, private readonly runtime: WorkspaceRuntime, private readonly acquireSource: AcquireSource) {}

  async list(): Promise<WorkspaceView[]> {
    return Promise.all((await this.store.list()).map((record) => this.observe(record)));
  }
  async show(name: string): Promise<WorkspaceView> { return this.observe(await this.store.read(workspaceName(name))); }

  private async observe(record: WorkspaceRecord): Promise<WorkspaceView> {
    try {
      const actual = await this.runtime.inspect(record);
      return { ...record, runtimeStatus: actual === undefined ? "missing" : actual.running ? "running" : "stopped" };
    } catch (error) {
      return { ...record, runtimeStatus: "unavailable", runtimeError: error instanceof Error ? error.message : String(error) };
    }
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const name = workspaceName(input.name);
    const resources = validateResources({ cpuCount: "2", memory: "4g", pidsLimit: "2048", ...input.resources });
    return this.store.withLock(name, async () => {
      try { await this.store.read(name); throw new UserError(`workspace '${name}' already exists`); }
      catch (error) { if (!(error instanceof MissingRecordError)) throw error; }
      await mkdir(path.join(this.store.root, "staging"), { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(path.join(this.store.root, "staging", "source-"));
      try {
        const source = await this.acquireSource({ source: input.source, destination: path.join(staging, "checkout") });
        const now = new Date().toISOString();
        let record: WorkspaceRecord = {
          schemaVersion: 10, id: randomUUID(), name, source, runtime: "container",
          image: input.image ?? workspaceImageReference(process.env.DIM_WORKSPACE_IMAGE), resources,
          git: input.git ?? { name: "DIM developer", email: "developer@dim.local" },
          initialized: false, phase: "creating", createdAt: now, updatedAt: now
        };
        await this.store.write(record);
        try {
          await this.runtime.create(record);
          await this.runtime.start(record);
          await this.runtime.seed(record, path.join(staging, "checkout"));
          record = await this.publish(record, { phase: "running", initialized: true });
          return record;
        } catch (error) { await this.fail(record, error); throw this.failure("create", name, error); }
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }

  start(name: string): Promise<WorkspaceRecord> {
    return this.change(name, "start", async (record) => {
      await this.runtime.start(record);
      return this.publish(record, { phase: "running" });
    }, (record) => this.requireInitialized(record));
  }

  stop(name: string): Promise<WorkspaceRecord> {
    return this.change(name, "stop", async (record) => {
      await this.runtime.stop(record);
      return this.publish(record, { phase: "stopped" });
    });
  }

  restart(name: string): Promise<WorkspaceRecord> {
    return this.change(name, "restart", async (record) => {
      await this.runtime.stop(record);
      await this.runtime.start(record);
      return this.publish(record, { phase: "running" });
    }, (record) => this.requireInitialized(record));
  }

  recreate(name: string): Promise<WorkspaceRecord> {
    return this.change(name, "recreate", async (record) => {
      // Workspace identity/storage remain; the container is replaced. No source reset.
      await this.runtime.remove(record, { keepData: true });
      await this.runtime.create(record);
      await this.runtime.start(record);
      return this.publish(record, { phase: "running" });
    }, (record) => this.requireInitialized(record));
  }

  resources(name: string, changes: Partial<WorkspaceResources>): Promise<{ workspace: WorkspaceRecord; recreated: boolean }> {
    let resources: WorkspaceResources;
    return this.change(name, "resources", async (record) => {
      const result = await this.runtime.updateResources(record, resources);
      return { workspace: await this.publish(record, { resources }), recreated: result.recreated };
    }, (record) => { resources = validateResources({ ...record.resources, ...changes }); });
  }

  async discard(name: string): Promise<void> {
    await this.change(name, "discard", async (record) => {
      await this.publish(record, { phase: "discarding" });
      await this.runtime.remove(record, { keepData: false });
      await this.store.remove(name);
    });
  }

  async exec(name: string, command: string[], options: RunOptions = {}): Promise<number> {
    if (!command.length || command.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
      throw new UserError("provide a command to execute in the workspace");
    }
    const record = await this.store.read(workspaceName(name));
    this.requireInitialized(record);
    if (record.phase !== "running") throw new UserError(`workspace '${name}' is ${record.phase}; run dim start ${name}`);
    return this.runtime.exec(record, command, options);
  }

  async connect(name: string, port: number, options: WorkspaceConnectOptions = {}): Promise<number> {
    validateWorkspacePort(port);
    const record = await this.store.read(workspaceName(name));
    this.requireInitialized(record);
    if (options.workspaceId !== undefined && options.workspaceId !== record.id) {
      throw new UserError(`workspace '${name}' was replaced; restart forwarding to connect to its new identity`);
    }
    if (record.phase !== "running") throw new UserError(`workspace '${name}' is ${record.phase}; run dim start ${name}`);
    return this.runtime.connect(record, port, options);
  }

  private async change<T>(name: string, operation: string, action: (record: WorkspaceRecord) => Promise<T>, validate: (record: WorkspaceRecord) => void = () => {}): Promise<T> {
    workspaceName(name);
    return this.store.withLock(name, async () => {
      const record = await this.store.read(name);
      validate(record);
      try { return await action(record); }
      catch (error) { await this.fail(record, error); throw this.failure(operation, name, error); }
    });
  }

  private requireInitialized(record: WorkspaceRecord): void {
    if (!record.initialized) throw new UserError(`workspace '${record.name}' initialization did not complete; inspect its error before discarding and creating it again`);
  }

  private async publish(record: WorkspaceRecord, changes: Partial<WorkspaceRecord>): Promise<WorkspaceRecord> {
    const next = { ...record, ...changes, updatedAt: new Date().toISOString() };
    if (next.initialized) delete next.error;
    await this.store.write(next);
    return next;
  }

  private async fail(record: WorkspaceRecord, error: unknown): Promise<void> {
    await this.store.write({ ...record, phase: "error", error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
  }

  private failure(operation: string, name: string, error: unknown): UserError {
    return new UserError(`workspace ${operation} '${name}': ${error instanceof Error ? error.message : String(error)}`);
  }
}
