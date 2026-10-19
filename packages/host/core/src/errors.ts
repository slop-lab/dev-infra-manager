export class UserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserError";
  }
}

export class MissingRecordError extends UserError {
  readonly name = "MissingRecordError";
}

export function isUserError(error: unknown): error is Error {
  return error instanceof Error && (error instanceof UserError || error.name === "UserError");
}

export function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new UserError(message);
  }
}
