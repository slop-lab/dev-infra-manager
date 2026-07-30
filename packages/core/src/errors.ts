export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function isUserError(error: unknown): error is Error {
  return error instanceof Error && (error instanceof UserError || error.name === "UserError");
}

export function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new UserError(message);
  }
}
