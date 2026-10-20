const maximumPendingBytes = 8 * 1024 * 1024;

export function createEventFollower(response: import("./qemu-types.js").EventResponse, onOverflow: ()=>void): import("./qemu-types.js").EventFollower {

  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let draining = false;
  let endRequested = false;
  let ended = false;
  let closed = false;

  const close = () => {
    closed = true;
    response.off("drain", flush);
    pending.length = 0;
    pendingBytes = 0;
  };
  const finish = () => {
    if (closed || ended || draining || pending.length > 0 || !endRequested) return;
    ended = true;
    response.end();
  };
  const flush = () => {
    if (closed) return;
    draining = false;
    while (pending.length > 0) {
      const chunk = pending.shift();
      if (chunk === undefined) break;
      pendingBytes -= chunk.length;
      if (!response.write(chunk)) {
        draining = true;
        response.once("drain", flush);
        return;
      }
    }
    finish();
  };
  response.once("close", close);
  response.once("error", close);

  return {
    end() {
      if (closed || endRequested) return;
      endRequested = true;
      finish();
    },
    write(chunk) {
      if (closed || endRequested) return;
      if (!draining) {
        if (!response.write(chunk)) {
          draining = true;
          response.once("drain", flush);
        }
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (pendingBytes + bytes.length > maximumPendingBytes) {
        close();
        onOverflow();
        response.destroy();
        return;
      }
      pending.push(bytes);
      pendingBytes += bytes.length;
    },
  };
}
