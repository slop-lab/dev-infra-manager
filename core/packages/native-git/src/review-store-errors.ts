export class ReviewStoreError extends Error {
  readonly name: string = "ReviewStoreError";
}

export class ReviewOutboxFullError extends ReviewStoreError {
  readonly name = "ReviewOutboxFullError";
  constructor() {
    super("review outbox is full");
  }
}
