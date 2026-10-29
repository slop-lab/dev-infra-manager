export class CoalescedAsyncOperations<Key, Value> {
  readonly #pending = new Map<Key, Promise<Value>>();

  async run(key: Key, operation: () => Promise<Value>): Promise<Value> {
    const existing = this.#pending.get(key);
    if (existing !== undefined) return existing;
    const pending = operation();
    this.#pending.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.#pending.get(key) === pending) this.#pending.delete(key);
    }
  }
}
