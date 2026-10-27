/** Git object IDs, never mutable branch names. */
export interface DiffSnapshot {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly files: readonly DiffFile[];
}
export interface DiffFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: "added" | "deleted" | "modified" | "renamed" | "copied";
  readonly binary: boolean;
  readonly oldBlob?: DiffBlob;
  readonly newBlob?: DiffBlob;
  readonly hunks: readonly DiffHunk[];
}
export interface DiffBlob {
  readonly blobId: string;
  readonly byteLength: number;
  readonly lineCount: number | null;
  readonly mode: string;
}
export interface DiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly DiffLine[];
}
export interface DiffLine {
  readonly kind: "context" | "addition" | "deletion";
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly noNewline?: boolean;
}
/** Persist the complete anchor; a later snapshot must never silently relocate it. */
export interface DiffLineAnchor {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly path: string;
  readonly side: "base" | "head";
  readonly line: number;
}
export interface ParseDiffOptions {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly maxLines?: number;
}
export class DiffParseError extends Error {
  override readonly name = "DiffParseError";
}
export function isGitObjectId(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}
function fail(message: string): never { throw new DiffParseError(message); }
function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) fail("Diff limits must be positive safe integers");
  return value;
}
/** Decode Git's core.quotePath C escapes, including UTF-8 octal bytes. */
function pathName(value: string, stripPrefix = false): string | null {
  let result = value;
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) fail("Unterminated quoted Git path");
    const bytes: number[] = [];
    for (let i = 1; i < value.length - 1; i++) {
      const character = value[i]!;
      if (character !== "\\") {
        const point = value.codePointAt(i)!;
        const encoded = new TextEncoder().encode(String.fromCodePoint(point));
        bytes.push(...encoded);
        if (point > 0xffff) i++;
      } else {
        const escaped = value[++i];
        if (escaped === undefined) fail("Invalid Git path escape");
        const octal = value.slice(i).match(/^[0-7]{1,3}/)?.[0];
        if (octal) { const byte = Number.parseInt(octal, 8); if (byte > 255) fail("Invalid path byte"); bytes.push(byte); i += octal.length - 1; }
        else {
          const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
          const byte = escapes[escaped];
          if (byte === undefined) fail("Invalid Git path escape");
          bytes.push(byte);
        }
      }
    }
    try { result = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); }
    catch { fail("Git path is not valid UTF-8"); }
  }
  if (result === "/dev/null") return null;
  if (stripPrefix && (result.startsWith("a/") || result.startsWith("b/"))) result = result.slice(2);
  if (!result || result.includes("\0")) fail("Invalid Git path");
  return result;
}
type MutableFile = { oldPath: string | null; newPath: string | null; status: DiffFile["status"]; binary: boolean; hunks: MutableHunk[] };
type MutableHunk = Omit<DiffHunk, "lines"> & { lines: Array<{ kind: DiffLine["kind"]; text: string; oldLine: number | null; newLine: number | null; noNewline?: boolean }> };
/** Parse ordinary two-parent unified Git output. Combined/merge diffs are rejected. */
export function parseGitDiff(patch: string, options: ParseDiffOptions): DiffSnapshot {
  if (!isGitObjectId(options.baseCommit) || !isGitObjectId(options.headCommit)) fail("Diff snapshots require complete Git object IDs");
  if (patch.length > limit(options.maxBytes, 4_000_000) || new TextEncoder().encode(patch).byteLength > limit(options.maxBytes, 4_000_000)) fail("Diff byte limit exceeded");
  const maxFiles = limit(options.maxFiles, 1_000);
  const maxLines = limit(options.maxLines, 100_000);
  const rows = patch.split("\n");
  if (rows.length > maxLines + 1) fail("Diff line limit exceeded");
  if (rows.at(-1) === "") rows.pop();
  const files: MutableFile[] = [];
  let file: MutableFile | undefined;
  let hunk: MutableHunk | undefined;
  let oldRemaining = 0, newRemaining = 0, oldLine = 0, newLine = 0;
  for (const row of rows) {
    if (row === "\\ No newline at end of file") {
      const previous = hunk?.lines.at(-1);
      if (!previous || previous.noNewline) fail("Unexpected no-newline marker");
      previous.noNewline = true; continue;
    }
    if (oldRemaining || newRemaining) {
      if (!hunk) fail("Missing diff hunk");
      const prefix = row[0];
      const kind = prefix === " " ? "context" : prefix === "+" ? "addition" : prefix === "-" ? "deletion" : fail("Truncated or malformed diff hunk");
      const usesOld = kind !== "addition", usesNew = kind !== "deletion";
      if ((usesOld && oldRemaining === 0) || (usesNew && newRemaining === 0)) fail("Diff hunk counts do not match");
      hunk.lines.push({ kind, text: row.slice(1), oldLine: usesOld ? oldLine++ : null, newLine: usesNew ? newLine++ : null });
      if (usesOld) oldRemaining--;
      if (usesNew) newRemaining--;
      continue;
    }
    if (hunk && row !== "" && !row.startsWith("diff --git ") && !row.startsWith("@@ ")) fail("Unexpected content after diff hunk");
    if (row.startsWith("diff --git ")) {
      const header = row.slice(11);
      const names = header.match(/^("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/);
      if (!names) fail("Malformed Git diff file header");
      let oldPath = pathName(names[1]!, true), newPath = pathName(names[2]!, true);
      // Unquoted paths can contain spaces, including the apparent separator.
      // Ordinary mode-only changes have no ---/+++ headers to disambiguate.
      const separator = (header.length - 1) / 2;
      if (header.startsWith("a/") && Number.isInteger(separator) && header.slice(separator, separator + 3) === " b/" && header.slice(2, separator) === header.slice(separator + 3)) {
        oldPath = pathName(header.slice(0, separator), true); newPath = pathName(header.slice(separator + 1), true);
      }
      file = { oldPath, newPath, status: "modified", binary: false, hunks: [] };
      files.push(file); hunk = undefined;
      if (files.length > maxFiles) fail("Diff file limit exceeded");
    } else if (row.startsWith("@@ ")) {
      if (!file) fail("Hunk without a Git file header");
      const match = row.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
      if (!match) fail("Malformed diff hunk header");
      const numbers = [match[1], match[2] ?? "1", match[3], match[4] ?? "1"].map(Number);
      if (numbers.some(n => !Number.isSafeInteger(n) || n < 0)) fail("Invalid diff line number");
      [oldLine, oldRemaining, newLine, newRemaining] = numbers as [number, number, number, number];
      if ((oldRemaining > 0 && oldLine === 0) || (newRemaining > 0 && newLine === 0)) fail("Invalid diff line number");
      hunk = { header: row, oldStart: oldLine, oldCount: oldRemaining, newStart: newLine, newCount: newRemaining, lines: [] }; file.hunks.push(hunk);
    } else if (file && row.startsWith("--- ")) { file.oldPath = pathName(row.slice(4), true); if (file.oldPath === null) file.status = "added"; }
    else if (file && row.startsWith("+++ ")) { file.newPath = pathName(row.slice(4), true); if (file.newPath === null) file.status = "deleted"; }
    else if (file && row.startsWith("rename from ")) { file.oldPath = pathName(row.slice(12)); file.status = "renamed"; }
    else if (file && row.startsWith("rename to ")) { file.newPath = pathName(row.slice(10)); file.status = "renamed"; }
    else if (file && row.startsWith("copy from ")) { file.oldPath = pathName(row.slice(10)); file.status = "copied"; }
    else if (file && row.startsWith("copy to ")) { file.newPath = pathName(row.slice(8)); file.status = "copied"; }
    else if (file && row.startsWith("new file mode ")) { file.oldPath = null; file.status = "added"; }
    else if (file && row.startsWith("deleted file mode ")) { file.newPath = null; file.status = "deleted"; }
    else if (file && (row.startsWith("Binary files ") || row === "GIT binary patch")) file.binary = true;
    else if (row.startsWith("diff --cc ") || row.startsWith("diff --combined ") || row.startsWith("@@@")) fail("Combined diffs are not supported");
    else if (file && /^(index |old mode |new mode |similarity index |dissimilarity index )/.test(row)) { /* presentation metadata */ }
    else if (file?.binary && /^(literal |delta |[A-Za-z])/.test(row)) { /* binary payload has no line anchors */ }
    else if (row !== "") fail("Unexpected Git diff content");
  }
  if (oldRemaining || newRemaining) fail("Truncated diff hunk");
  return { baseCommit: options.baseCommit, headCommit: options.headCommit, files };
}
export function lineAnchor(snapshot: Pick<DiffSnapshot, "baseCommit" | "headCommit">, file: DiffFile, line: DiffLine, side: "base" | "head"): DiffLineAnchor | null {
  const path = side === "base" ? file.oldPath : file.newPath;
  const number = side === "base" ? line.oldLine : line.newLine;
  return path !== null && number !== null ? { baseCommit: snapshot.baseCommit, headCommit: snapshot.headCommit, path, side, line: number } : null;
}

/** Validate untrusted JSON at a service boundary without coupling the model to a transport. */
export function parseDiffSnapshot(value: unknown): DiffSnapshot {
  function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("Expected diff object");
    return input as Record<string, unknown>;
  }
  let totalBytes = 0;
  function text(input: unknown): string {
    if (typeof input !== "string" || input.includes("\0")) fail("Expected diff text");
    totalBytes += new TextEncoder().encode(input).byteLength;
    if (totalBytes > 4_000_000) fail("Diff byte limit exceeded");
    return input;
  }
  function number(input: unknown): number { if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) fail("Expected nonnegative diff integer"); return input; }
  function array(input: unknown): unknown[] { if (!Array.isArray(input)) fail("Expected diff array"); return input; }
  function path(input: unknown): string | null { if (input === null) return null; const result = text(input); if (!result) fail("Empty diff path"); return result; }
  function blob(input: unknown): DiffBlob {
    const item = record(input), blobId = text(item.blobId);
    if (!isGitObjectId(blobId)) fail("Expected complete blob object ID");
    const mode = text(item.mode); if (!/^[0-7]{6}$/.test(mode)) fail("Invalid Git file mode");
    return { blobId, mode, byteLength: number(item.byteLength), lineCount: item.lineCount === null ? null : number(item.lineCount) };
  }
  const document = record(value), baseCommit = text(document.baseCommit), headCommit = text(document.headCommit);
  if (!isGitObjectId(baseCommit) || !isGitObjectId(headCommit)) fail("Diff snapshots require complete Git object IDs");
  let totalLines = 0;
  const fileValues = array(document.files);
  if (fileValues.length > 1_000) fail("Diff file limit exceeded");
  const files: DiffFile[] = fileValues.map(input => {
    const file = record(input), oldPath = path(file.oldPath), newPath = path(file.newPath);
    if (oldPath === null && newPath === null) fail("Diff file has no path");
    if (typeof file.binary !== "boolean") fail("Expected binary diff flag");
    const status = file.status;
    if (status !== "added" && status !== "deleted" && status !== "modified" && status !== "renamed" && status !== "copied") fail("Invalid diff file status");
    if ((status === "added" && (oldPath !== null || newPath === null)) || (status === "deleted" && (newPath !== null || oldPath === null))) fail("Inconsistent diff file status");
    const hunks: DiffHunk[] = array(file.hunks).map(input => {
      const item = record(input), oldStart = number(item.oldStart), oldCount = number(item.oldCount), newStart = number(item.newStart), newCount = number(item.newCount);
      let oldCursor = oldStart, newCursor = newStart;
      const lines: DiffLine[] = array(item.lines).map(input => {
        if (++totalLines > 100_000) fail("Diff line limit exceeded");
        const line = record(input), kind = line.kind;
        if (kind !== "context" && kind !== "addition" && kind !== "deletion") fail("Invalid diff line kind");
        const oldLine = line.oldLine === null ? null : number(line.oldLine), newLine = line.newLine === null ? null : number(line.newLine);
        if ((kind === "addition" ? oldLine !== null : oldLine !== oldCursor++) || (kind === "deletion" ? newLine !== null : newLine !== newCursor++)) fail("Inconsistent diff line coordinates");
        if ((oldLine !== null && oldLine < 1) || (newLine !== null && newLine < 1)) fail("Invalid diff line number");
        if (line.noNewline !== undefined && typeof line.noNewline !== "boolean") fail("Invalid no-newline flag");
        return { kind, oldLine, newLine, text: text(line.text), ...(line.noNewline === undefined ? {} : { noNewline: line.noNewline as boolean }) };
      });
      if (oldCursor !== oldStart + oldCount || newCursor !== newStart + newCount) fail("Diff hunk counts do not match");
      return { header: text(item.header), oldStart, oldCount, newStart, newCount, lines };
    });
    if (file.binary && hunks.length) fail("Binary file cannot contain text hunks");
    return { oldPath, newPath, status, binary: file.binary, hunks, ...(file.oldBlob === undefined ? {} : { oldBlob: blob(file.oldBlob) }), ...(file.newBlob === undefined ? {} : { newBlob: blob(file.newBlob) }) };
  });
  return { baseCommit, headCommit, files };
}
