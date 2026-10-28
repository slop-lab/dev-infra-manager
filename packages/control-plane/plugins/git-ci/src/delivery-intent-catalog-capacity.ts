export class DeliveryIntentCatalogCapacity {
  readonly #maximumEntries: number;
  readonly #maximumBytes: number;
  #entries = 0;
  #bytes = 0;

  constructor(maximumEntries: number, maximumBytes: number) {
    this.#maximumEntries = maximumEntries;
    this.#maximumBytes = maximumBytes;
  }

  replace(previousBytes: number | undefined, nextBytes: number): void {
    const entries = this.#entries + (previousBytes === undefined ? 1 : 0);
    const bytes = this.#bytes - (previousBytes ?? 0) + nextBytes;
    this.assertWithinLimits(entries, bytes);
    this.#entries = entries;
    this.#bytes = bytes;
  }

  assertAdditional(entries: number, bytes: number): void {
    this.assertWithinLimits(this.#entries + entries, this.#bytes + bytes);
  }

  private assertWithinLimits(entries: number, bytes: number): void {
    if (entries > this.#maximumEntries || bytes > this.#maximumBytes) {
      throw new DeliveryIntentCatalogCapacityError(
        "authoritative delivery intent catalog memory capacity is exceeded"
      );
    }
  }
}

export class DeliveryIntentCatalogCapacityError extends Error {
  readonly name = "DeliveryIntentCatalogCapacityError";
}
