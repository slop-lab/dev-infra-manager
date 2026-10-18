export function sqliteUnavailable(error: unknown): boolean {
  if (!(error instanceof Error) || !("errcode" in error) || typeof error.errcode !== "number") return false;
  return [5, 6, 8, 10, 13, 14].includes(error.errcode & 0xff);
}
