export type ProjectionCacheEntry<Value> = {
  readonly attachmentId: string;
  readonly value: Value;
  readonly bytes: number;
};

export class BoundedProjectionCache<Key, Value> {
  readonly #entries = new Map<Key, ProjectionCacheEntry<Value>>();
  #bytes = 0;

  constructor(
    readonly maximumEntries: number,
    readonly maximumBytes: number
  ) {}

  get(key: Key): ProjectionCacheEntry<Value> | undefined {
    return this.#entries.get(key);
  }

  get entryCount(): number {
    return this.#entries.size;
  }

  get encodedBytes(): number {
    return this.#bytes;
  }

  touch(key: Key, entry: ProjectionCacheEntry<Value>): void {
    if (this.#entries.get(key) !== entry) return;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  set(key: Key, attachmentId: string, value: Value): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maximumBytes) return;
    const previous = this.#entries.get(key);
    if (previous !== undefined) {
      this.#entries.delete(key);
      this.#bytes -= previous.bytes;
    }
    while (this.#entries.size >= this.maximumEntries || this.#bytes + bytes > this.maximumBytes) {
      const oldest = this.#entries.entries().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes;
    }
    this.#entries.set(key, { attachmentId, value, bytes });
    this.#bytes += bytes;
  }
}
