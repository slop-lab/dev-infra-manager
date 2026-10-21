export type Session = NonNullable<ReturnType<typeof import("./session-data.js").parseSession>>;
export type Operation = import("./operation-coordinator.js").Operation;
export interface RequestResult { body: unknown; ok: boolean; status: number }
