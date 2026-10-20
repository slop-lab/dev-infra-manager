import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { visit } from "jsonc-parser";
import { z } from "zod";
import type { ReviewChangeMatcher } from "./change-matchers.js";

const optionsSchema = z.object({
  path: z.string().min(1).max(1024).refine((path) => !path.startsWith("/")
    && !/[\0\r\n]/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
  pointer: z.string().max(4096).refine((pointer) => pointer === ""
    || (pointer.startsWith("/") && !/~(?:[^01]|$)/.test(pointer)))
}).strict();
const absent = Symbol("absent JSON field");
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Invalid or ambiguous input escalates to human review; it never means no change. */
export const jsonFieldMatcher: ReviewChangeMatcher = {
  name: "json-field",
  revision: createHash("sha256").update(readFileSync(new URL(import.meta.url))).update("jsonc-parser@3.3.1").digest("hex"),
  validate(options) { optionsSchema.parse(options); },
  async matches(input) {
    const options = optionsSchema.parse(input.options);
    const path = Buffer.from(options.path);
    for (const change of input.changes) {
      const oldMatches = Buffer.from(change.oldPathBytes, "base64").equals(path);
      const newMatches = Buffer.from(change.newPathBytes, "base64").equals(path);
      if (!oldMatches && !newMatches) continue;
      // Moving/removing a protected document, changing its type or executable mode
      // needs review even when the selected field happens to look identical.
      if (!oldMatches || !newMatches || change.oldMode !== "100644" || change.newMode !== "100644") return true;
      try {
        const before = strictJson(await input.readBlob(change.oldObjectId));
        const after = strictJson(await input.readBlob(change.newObjectId));
        if (!isDeepStrictEqual(field(before, options.pointer), field(after, options.pointer))) return true;
      } catch {
        return true;
      }
    }
    return false;
  }
};

function strictJson(bytes: Buffer): unknown {
  if (bytes.length > 1024 * 1024) throw new Error("review JSON exceeds 1 MiB");
  const text = decoder.decode(bytes);
  const value: unknown = JSON.parse(text);
  const objects: Set<string>[] = [];
  let depth = 0;
  const enter = () => { if (++depth > 64) throw new Error("review JSON exceeds nesting limit"); };
  visit(text, {
    onObjectBegin() { enter(); objects.push(new Set()); },
    onObjectProperty(name) {
      const current = objects.at(-1);
      if (!current || current.has(name)) throw new Error("duplicate JSON property");
      current.add(name);
    },
    onObjectEnd() { objects.pop(); depth--; },
    onArrayBegin: enter,
    onArrayEnd() { depth--; },
    onLiteralValue(literal: unknown) {
      if (typeof literal === "number" && !Number.isSafeInteger(literal)) throw new Error("ambiguous JSON number requires review");
    },
    onError() { throw new Error("invalid review JSON"); }
  }, { disallowComments: true, allowTrailingComma: false });
  return value;
}

function field(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return absent;
    if (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(key)) return absent;
    value = Reflect.get(value, key) as unknown;
  }
  return value;
}
