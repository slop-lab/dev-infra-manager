export type ReviewerElements = ReturnType<typeof import("./reviewer-elements.js").reviewerElements>;
export type Session = NonNullable<ReturnType<typeof import("./review-data.js").parseSession>>;
export type Operation = import("./operation-coordinator.js").Operation;
export interface RequestResult { body: unknown; ok: boolean; status: number }
export interface ReviewLifecycle {
  session(): Session | null;
  isPending(button: HTMLButtonElement): boolean;
  startOperation(button?: HTMLButtonElement | null): Operation;
  isCurrent(operation: Operation): boolean;
  request(path: string, operation: Operation, options?: RequestInit): Promise<RequestResult>;
  openReview(reviewId: string, operation: Operation): Promise<void>;
  showSignedOut(message?: string): void;
  endBusy(button: HTMLButtonElement): void;
  lockNavigation(): void;
  unlockNavigation(): void;
}
