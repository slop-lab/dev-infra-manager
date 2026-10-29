import { RepositoryStateError } from "./state.js";

export class RepositoryAdmission {
  readonly #reads = new Set<Promise<unknown>>();
  #barrier = Promise.resolve();
  #accepting = true;
  #closePromise: Promise<void> | undefined;

  runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (!this.#accepting) return this.#rejected();
    const pending = this.#barrier.then(operation);
    this.#barrier = pending.then(() => undefined, () => undefined);
    return pending;
  }

  runRead<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (!this.#accepting) return this.#rejected();
    let pending: Promise<Result>;
    try {
      pending = operation();
    } catch (error) {
      return Promise.reject(error);
    }
    this.#reads.add(pending);
    void pending.then(
      () => this.#reads.delete(pending),
      () => this.#reads.delete(pending),
    );
    return pending;
  }

  close(release: () => void): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#accepting = false;
    this.#closePromise = Promise.allSettled([this.#barrier, ...this.#reads]).then(() => release());
    return this.#closePromise;
  }

  accepting(): boolean {
    return this.#accepting;
  }

  #rejected<Result>(): Promise<Result> {
    return Promise.reject(new RepositoryStateError("repository authority is closing or closed"));
  }
}
