import type { Page } from "playwright-core";

/** Disposable journeys register resources immediately after creating them. */
export interface JourneyContext {
  readonly page: Page;
  readonly artifactDirectory: string;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  cleanup(action: () => Promise<void>): void;
  /** Diagnostics deliberately exclude free-form strings and service responses. */
  diagnostic(name: string, value: number | boolean | null): void;
}
