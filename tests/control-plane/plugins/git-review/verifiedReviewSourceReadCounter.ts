import { open } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

type BodyReadCounter = { readonly bytes: () => number; readonly reset: () => void; readonly restore: () => void };

export async function installBodyReadCounter(): Promise<BodyReadCounter> {
  const handle = await open("/dev/null", "r");
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const original = Reflect.get(prototype, "readFile");
  if (typeof original !== "function") throw new Error("FileHandle.readFile is unavailable");
  let bytes = 0;
  Reflect.set(prototype, "readFile", async function(this: object, ...args: readonly unknown[]): Promise<unknown> {
    const value = await Reflect.apply(original, this, args);
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    else if (Buffer.isBuffer(value)) bytes += value.length;
    return value;
  });
  syncBuiltinESMExports();
  return {
    bytes: () => bytes,
    reset: () => { bytes = 0; },
    restore: () => {
      Reflect.set(prototype, "readFile", original);
      syncBuiltinESMExports();
    }
  };
}
