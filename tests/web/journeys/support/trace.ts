export interface JourneyStep {
  name: string;
  milliseconds: number;
  result: "passed" | "failed";
}

const endpointFamilies = new Set(["session", "accounts", "extensions", "operations"]);
const extensions = new Set(["native-git", "llm-router", "execution", "agent-tools", "external-urls"]);
const errorCategories = new Set(["TimeoutError", "AssertionError", "TypeError", "Error"]);

export function safeErrorCategory(error: unknown): string {
  return error instanceof Error && errorCategories.has(error.name) ? error.name : "UnknownError";
}

/** Arbitrary URLs can contain credentials in their path as well as their query. */
export function endpointFamily(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/");
    if (segments[1] !== "v1" || !endpointFamilies.has(segments[2] ?? "")) return "other";
    if (segments[2] === "extensions" && extensions.has(segments[3] ?? "")) {
      const action = segments[4] === "operations" ? "operations/*" : segments[4] === "reconnect" ? "reconnect" : "*";
      return `/v1/extensions/${segments[3]}/${action}`;
    }
    return `/v1/${segments[2]}/*`;
  } catch { return "other"; }
}

export function safeLabel(value: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9 ._:/()-]{0,119}$/.test(value)) throw new Error("Journey labels must be fixed descriptive names");
  return value;
}
