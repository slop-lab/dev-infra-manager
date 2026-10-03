import { z } from "zod";

const forbiddenDisplayCodePoint = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u;
const forbiddenPatchCodePoint = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u;

export function printableText(maxLength: number) {
  return z.string().max(maxLength).refine((value) => !forbiddenDisplayCodePoint.test(value));
}

export function printablePatch(maxLength: number) {
  return z.string().max(maxLength).refine((value) => !forbiddenPatchCodePoint.test(value));
}
