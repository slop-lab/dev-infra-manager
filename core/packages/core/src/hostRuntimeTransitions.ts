import { UserError } from "./errors.js";

export interface HostRuntimeSupervisor {
  dispose(): Promise<void>;
  quiesce(): Promise<void>;
  resume(): Promise<void>;
}

export class HostRuntimeTransitions {
  readonly #supervisor: HostRuntimeSupervisor | undefined;
  #transition: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(supervisor?: HostRuntimeSupervisor) {
    this.#supervisor = supervisor;
  }

  run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    if (operation !== "host.start" && operation !== "host.shutdown") return action();
    if (this.#disposed) return Promise.reject(new UserError("host runtime transitions are disposed"));
    const result = this.#transition.then(async () => {
      if (this.#disposed) throw new UserError("host runtime transitions are disposed");
      if (operation === "host.shutdown") {
        await this.#supervisor?.quiesce();
        if (this.#disposed) throw new UserError("host runtime transitions are disposed");
      }
      const value = await action();
      if (operation === "host.start") {
        if (this.#disposed) throw new UserError("host runtime transitions are disposed");
        await this.#supervisor?.resume();
      }
      return value;
    });
    this.#transition = result.then(() => undefined, () => undefined);
    return result;
  }

  dispose(): Promise<void> {
    this.#disposed = true;
    const result = this.#transition.then(async () => await this.#supervisor?.dispose());
    this.#transition = result.catch(() => undefined);
    return result;
  }
}
