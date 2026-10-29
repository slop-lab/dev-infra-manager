export class DeliveryIntentCatalogCapacity {
  readonly #maximumEntries: number;
  readonly #maximumBytes: number;
  #entries = 0;
  #bytes = 0;
  #reservedEntries = 0;
  #reservedBytes = 0;

  constructor(maximumEntries: number, maximumBytes: number) {
    this.#maximumEntries = maximumEntries;
    this.#maximumBytes = maximumBytes;
  }

  replace(previousBytes: number | undefined, nextBytes: number): void {
    const entries = this.#entries + (previousBytes === undefined ? 1 : 0);
    const bytes = this.#bytes - (previousBytes ?? 0) + nextBytes;
    this.assertWithinLimits(entries + this.#reservedEntries, bytes + this.#reservedBytes);
    this.#entries = entries;
    this.#bytes = bytes;
  }

  assertAdditional(entries: number, bytes: number): void {
    this.assertWithinLimits(
      this.#entries + this.#reservedEntries + entries,
      this.#bytes + this.#reservedBytes + bytes
    );
  }

  reserve(entries: number, bytes: number): DeliveryIntentCatalogCapacityReservation {
    this.assertAdditional(entries, bytes);
    this.#reservedEntries += entries;
    this.#reservedBytes += bytes;
    return new DeliveryIntentCatalogCapacityReservation(this, entries, bytes);
  }

  consumeAddition(bytes: number): void {
    this.#reservedEntries -= 1;
    this.#reservedBytes -= bytes;
    this.#entries += 1;
    this.#bytes += bytes;
  }

  consumeReplacement(previousBytes: number, nextBytes: number): void {
    this.#reservedBytes -= Math.max(0, nextBytes - previousBytes);
    this.#bytes += nextBytes - previousBytes;
  }

  release(entries: number, bytes: number): void {
    this.#reservedEntries -= entries;
    this.#reservedBytes -= bytes;
  }

  private assertWithinLimits(entries: number, bytes: number): void {
    if (entries > this.#maximumEntries || bytes > this.#maximumBytes) {
      throw new DeliveryIntentCatalogCapacityError(
        "authoritative delivery intent catalog memory capacity is exceeded"
      );
    }
  }
}

export class DeliveryIntentCatalogCapacityReservation {
  readonly #capacity: DeliveryIntentCatalogCapacity;
  #entries: number;
  #bytes: number;

  constructor(capacity: DeliveryIntentCatalogCapacity, entries: number, bytes: number) {
    this.#capacity = capacity;
    this.#entries = entries;
    this.#bytes = bytes;
  }

  consumeAddition(bytes: number): void {
    if (this.#entries < 1 || bytes < 0 || bytes > this.#bytes) {
      throw new DeliveryIntentCatalogCapacityError("delivery intent catalog reservation is invalid");
    }
    this.#entries -= 1;
    this.#bytes -= bytes;
    this.#capacity.consumeAddition(bytes);
  }

  consumeReplacement(previousBytes: number, nextBytes: number): void {
    const growth = Math.max(0, nextBytes - previousBytes);
    if (this.#entries !== 0 || growth > this.#bytes) {
      throw new DeliveryIntentCatalogCapacityError("delivery intent catalog reservation is invalid");
    }
    this.#bytes -= growth;
    this.#capacity.consumeReplacement(previousBytes, nextBytes);
  }

  transferAddition(bytes: number): DeliveryIntentCatalogCapacityReservation {
    if (this.#entries < 1 || bytes < 0 || bytes > this.#bytes) {
      throw new DeliveryIntentCatalogCapacityError("delivery intent catalog reservation is invalid");
    }
    this.#entries -= 1;
    this.#bytes -= bytes;
    return new DeliveryIntentCatalogCapacityReservation(this.#capacity, 1, bytes);
  }

  transferReplacement(previousBytes: number,
    nextBytes: number): DeliveryIntentCatalogCapacityReservation {
    const growth = Math.max(0, nextBytes - previousBytes);
    if (this.#entries !== 0 || growth > this.#bytes) {
      throw new DeliveryIntentCatalogCapacityError("delivery intent catalog reservation is invalid");
    }
    this.#bytes -= growth;
    return new DeliveryIntentCatalogCapacityReservation(this.#capacity, 0, growth);
  }

  release(): void {
    this.#capacity.release(this.#entries, this.#bytes);
    this.#entries = 0;
    this.#bytes = 0;
  }
}

export class DeliveryIntentCatalogCapacityError extends Error {
  readonly name = "DeliveryIntentCatalogCapacityError";
}
