import type { AuthoritativeNativeChangedPath } from "@slop-lab/gs-review-contracts";

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function parseChangedPaths(input: {
  readonly raw: Uint8Array;
  readonly readBlob: (objectId: string) => Promise<Buffer>;
}): Promise<readonly AuthoritativeNativeChangedPath[]> {
  const fields = splitNul(Buffer.from(input.raw));
  const changes: AuthoritativeNativeChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    const metadata = fields[index];
    const firstPath = fields[index + 1];
    if (metadata === undefined || firstPath === undefined) throw new ChangedPathError("Git raw diff is incomplete");
    const parsed = parseMetadata(metadata.toString("ascii"));
    const pair = parsed.status === "renamed" || parsed.status === "copied";
    const secondPath = pair ? fields[index + 2] : undefined;
    if (pair && secondPath === undefined) throw new ChangedPathError("Git rename diff is incomplete");
    const oldPath = parsed.status === "added" ? Buffer.alloc(0) : firstPath;
    const newPath = parsed.status === "deleted" ? Buffer.alloc(0) : (secondPath ?? firstPath);
    const oldTarget = parsed.oldMode === "120000" ? await input.readBlob(parsed.oldObjectId) : undefined;
    const newTarget = parsed.newMode === "120000" ? await input.readBlob(parsed.newObjectId) : undefined;
    changes.push({
      ...parsed,
      ...(oldPath.length === 0 ? {} : { oldPath: displayBytes(oldPath) }),
      ...(newPath.length === 0 ? {} : { newPath: displayBytes(newPath) }),
      oldPathBytes: oldPath.toString("base64"),
      newPathBytes: newPath.toString("base64"),
      ...(oldTarget === undefined ? {} : {
        oldSymlinkTarget: displayBytes(oldTarget),
        oldSymlinkTargetBytes: oldTarget.toString("base64"),
      }),
      ...(newTarget === undefined ? {} : {
        newSymlinkTarget: displayBytes(newTarget),
        newSymlinkTargetBytes: newTarget.toString("base64"),
      }),
    });
    index += pair ? 3 : 2;
  }
  return changes;
}

function parseMetadata(value: string): Omit<AuthoritativeNativeChangedPath,
  "oldPath" | "newPath" | "oldPathBytes" | "newPathBytes" | "oldSymlinkTarget"
  | "newSymlinkTarget" | "oldSymlinkTargetBytes" | "newSymlinkTargetBytes"> {
  const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMTRC])([0-9]{1,3})?$/.exec(value);
  const oldMode = match?.[1];
  const newMode = match?.[2];
  const oldObject = match?.[3];
  const newObject = match?.[4];
  const code = match?.[5];
  if (oldMode === undefined || newMode === undefined || oldObject === undefined
    || newObject === undefined || code === undefined) throw new ChangedPathError("Git raw diff metadata is unsupported");
  const status = code === "A" ? "added" : code === "D" ? "deleted" : code === "M" ? "modified"
    : code === "R" ? "renamed" : code === "C" ? "copied" : "type-changed";
  const score = match?.[6];
  return {
    status,
    oldMode,
    newMode,
    oldObjectId: /^0+$/.test(oldObject) ? "0" : oldObject,
    newObjectId: /^0+$/.test(newObject) ? "0" : newObject,
    ...(score === undefined ? {} : { similarity: Number.parseInt(score, 10) }),
  };
}

function splitNul(value: Buffer): readonly Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    fields.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start !== value.length) throw new ChangedPathError("Git raw diff is not NUL terminated");
  return fields;
}

function displayBytes(value: Buffer): string {
  try {
    return decoder.decode(value);
  } catch (error) {
    if (error instanceof TypeError) return `<base64:${value.toString("base64")}>`;
    throw error;
  }
}

export class ChangedPathError extends Error {
  readonly name = "ChangedPathError";
}
