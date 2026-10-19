import { Readable } from "node:stream";
import { spec, type TestEvent } from "node:test/reporters";

async function* selected(source: AsyncIterable<TestEvent>): AsyncGenerator<TestEvent> {
  for await (const event of source) {
    if (process.env.DIM_CHECK_VERBOSE === "1"
      || !["test:pass", "test:complete", "test:enqueue", "test:dequeue", "test:start"].includes(event.type)) {
      // Node does not reliably attribute stdout/stderr to a final test result.
      // Retain those bytes, diagnostics and future event types rather than hide
      // startup/crash evidence. Only known successful progress rows are omitted.
      yield event;
    }
  }
}

/** Let Node's own spec reporter format failures, nested causes and final counts. */
export default async function* failureOnly(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const formatted = Readable.from(selected(source)).compose(new spec());
  for await (const value of formatted) {
    const chunk: unknown = value;
    if (typeof chunk === "string") yield chunk;
    else if (Buffer.isBuffer(chunk)) yield chunk.toString("utf8");
    else throw new Error("unexpected Node test reporter output");
  }
}
